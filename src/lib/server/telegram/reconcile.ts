// Rebuilds the index by walking the group, so backups made by another machine
// (or before this database existed) show up and aren't uploaded twice.
import { randomUUID } from 'node:crypto';
import { log } from '$lib/server/logger';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import { telegramMarkerAdapter } from '$adapters/classes/telegram-marker.adapter';
import { telegramMessageAdapter } from '$adapters/classes/telegram-message.adapter';
import { asObject, stringifyCanonical } from '$utils/json/losslessJson';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { FilePart, MultipartMarker } from '$types/telegram-server.type';
import { iterateHistory } from './chat';
import type { BackupGroup } from './backup-group';

/**
 * `all` also adopts unmarked zips and stages incomplete groups across walks.
 * The other two are single-pass walks for one kind of marked upload.
 */
type Filter = { kind: 'all' } | { kind: 'metadata' } | { kind: 'pipeline'; id: string };

interface Group extends Omit<MultipartMarker, 'index' | 'partChecksum'> {
	chunks: FilePart[];
}

const SEPARATOR = String.fromCharCode(0);

/**
 * Groups key on (name, size, total) rather than the marker's groupId, which
 * older uploads minted per attempt and so split resumed files apart.
 */
export function multipartGroupKey(name: string, size: number, total: number): string {
	return [name, size, total].join(SEPARATOR);
}

function keepMarked(filter: Filter, marker: MultipartMarker): boolean {
	if (filter.kind === 'all') return true;
	const metadata = asObject(marker.metadata);
	if (filter.kind === 'metadata') return metadata?.role === 'metadata';
	return metadata?.pipelineId === filter.id && metadata.role !== 'metadata';
}

export async function reconcileIndex(group: BackupGroup): Promise<number> {
	const { value, ran } = await group.indexReconciled.run(
		async () => (await walkAndMint(group, { kind: 'all' })).length
	);
	return ran ? value : 0;
}

export async function reconcileMetadataOnly(group: BackupGroup): Promise<number> {
	const { value, ran } = await group.metadataReconciled.run(
		async () => (await walkAndMint(group, { kind: 'metadata' })).length
	);
	return ran ? value : 0;
}

export async function reconcileMediaForPipeline(
	group: BackupGroup,
	id: string
): Promise<string | null> {
	return (await walkAndMint(group, { kind: 'pipeline', id }))[0] ?? null;
}

/** Returns the ids it minted. */
export async function walkAndMint(
	{ connection, db, peer: target }: BackupGroup,
	filter: Filter
): Promise<string[]> {
	const full = filter.kind === 'all';
	const minted: string[] = [];
	const groups = new Map<string, Group>();

	const groupFor = (marker: Omit<Group, 'chunks'>): Group => {
		const key = multipartGroupKey(marker.name, marker.size, marker.total);
		let group = groups.get(key);
		if (!group) {
			group = { ...marker, chunks: [] };
			groups.set(key, group);
		}
		return group;
	};

	if (full) {
		// What earlier walks saw, so chunks accumulate until the group is whole.
		for (const pending of db.loadPendingChunks()) {
			const { name, declaredSize, total, mime, caption, checksum } = pending;
			const metadata = telegramFileAdapter.metadataFromRow(pending);
			groupFor({ name, size: declaredSize, total, mime, caption, checksum, metadata }).chunks.push({
				ord: pending.ord,
				tgMessageId: pending.tgMessageId,
				sizeBytes: pending.sizeBytes,
				checksumSha256: pending.partChecksum
			});
		}
	}

	for await (const message of iterateHistory(connection, target)) {
		const document = telegramMessageAdapter.documentFrom(message);
		if (!document?.name) continue;
		const text = telegramMessageAdapter.textFrom(message);

		const marker = telegramMarkerAdapter.fromCaption(text);
		if (marker) {
			if (!keepMarked(filter, marker)) continue;
			// Don't skip a chunk for already having a part row: a half-finished mint
			// would then hide it on every later walk. healAndMint sorts that out.
			const { index, partChecksum, ...shared } = marker;
			const group = groupFor(shared);
			group.checksum ??= marker.checksum;
			group.metadata ??= marker.metadata;
			if (!group.chunks.some((chunk) => chunk.ord === index)) {
				group.chunks.push({
					ord: index,
					tgMessageId: message.id,
					sizeBytes: document.size,
					checksumSha256: partChecksum
				});
			}
			continue;
		}

		// Unmarked documents count only when they are zips.
		if (!full || !isAllowedBackup(document.name, document.mimeType)) continue;
		if (db.findByMessageId(message.id) || db.partMessageIdExists(message.id)) continue;

		const id = randomUUID();
		db.insert({
			id,
			name: document.name,
			sizeBytes: document.size,
			mimeType: document.mimeType,
			tgMessageId: message.id,
			text: text || null,
			checksumSha256: null,
			metadata: null
		});
		db.insertPart(id, {
			ord: 0,
			tgMessageId: message.id,
			sizeBytes: document.size,
			checksumSha256: null
		});
		minted.push(id);
	}

	for (const [groupId, group] of groups) {
		const { name, size, total, mime, caption, checksum } = group;
		const chunks = group.chunks.sort((a, b) => a.ord - b.ord);
		const metadata = group.metadata === undefined ? null : stringifyCanonical(group.metadata);
		const complete = chunks.length === total && chunks.every((chunk, i) => chunk.ord === i);

		if (!complete) {
			if (!full) continue;
			for (const chunk of chunks) {
				db.upsertPendingPart({
					groupId,
					ord: chunk.ord,
					tgMessageId: chunk.tgMessageId,
					sizeBytes: chunk.sizeBytes,
					partChecksum: chunk.checksumSha256,
					total,
					name,
					declaredSize: size,
					mime,
					caption,
					checksum,
					metadata
				});
			}
			continue;
		}

		// Trust the declared size only when the chunks add up to it.
		const sum = chunks.reduce((bytes, chunk) => bytes + chunk.sizeBytes, 0);
		const finalSize = size > 0 && size === sum ? size : sum;
		const id = db.healAndMint({ name, finalSize, mime, caption, checksum, metadata, chunks });
		if (id) minted.push(id);
		if (full) db.deletePendingByIdentity(name, size, total);
	}

	log.info(`group reconcile finished: ${minted.length} new backups indexed`);
	return minted;
}
