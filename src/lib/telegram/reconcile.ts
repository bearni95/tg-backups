// Rebuilds the index by walking the group, so backups made by another machine
// (or before this database existed) show up and aren't uploaded twice.
import { randomUUID } from 'node:crypto';
import { log } from '$lib/logger';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import { telegramMarkerAdapter } from '$adapters/classes/telegram-marker.adapter';
import { telegramMessageAdapter } from '$adapters/classes/telegram-message.adapter';
import { stringifyCanonical } from '$utils/json/losslessJson';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { FilePart, MultipartMarker } from '$types/telegram-engine.type';
import { iterateHistory } from './chat';
import type { BackupGroup } from './backup-group';

interface Group extends Omit<MultipartMarker, 'index' | 'partChecksum'> {
	chunks: FilePart[];
	/** Further messages for an ord already seen: other copies of the same backup. */
	repeats: FilePart[];
}

const SEPARATOR = String.fromCharCode(0);

/**
 * Groups key on (name, size, total) rather than the marker's groupId, which
 * older uploads minted per attempt and so split resumed files apart.
 */
export function multipartGroupKey(name: string, size: number, total: number): string {
	return [name, size, total].join(SEPARATOR);
}

/** The complete copies among repeated chunks, which come newest first. */
function completeCopies(repeats: FilePart[], total: number): FilePart[][] {
	const copies: FilePart[][] = [];
	if (repeats.length < total || total === 0) return copies;

	const byOrd = new Map<number, FilePart[]>();
	for (const chunk of repeats) byOrd.set(chunk.ord, [...(byOrd.get(chunk.ord) ?? []), chunk]);
	for (;;) {
		const copy: FilePart[] = [];
		for (let ord = 0; ord < total; ord++) {
			const chunk = byOrd.get(ord)?.[copies.length];
			if (!chunk) return copies;
			copy.push(chunk);
		}
		copies.push(copy);
	}
}

export async function reconcileIndex(group: BackupGroup): Promise<number> {
	const { value, ran } = await group.indexReconciled.run(
		async () => (await walkAndMint(group)).length
	);
	return ran ? value : 0;
}

/**
 * Indexes the backups in the group, adopting unmarked zips and staging
 * incomplete ones across walks. Returns the ids it minted.
 */
export async function walkAndMint({
	connection,
	db,
	peer: target
}: BackupGroup): Promise<string[]> {
	const minted: string[] = [];
	const groups = new Map<string, Group>();

	const groupFor = (marker: Omit<Group, 'chunks' | 'repeats'>): Group => {
		const key = multipartGroupKey(marker.name, marker.size, marker.total);
		let group = groups.get(key);
		if (!group) {
			group = { ...marker, chunks: [], repeats: [] };
			groups.set(key, group);
		}
		return group;
	};

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

	for await (const message of iterateHistory(connection, target)) {
		const document = telegramMessageAdapter.documentFrom(message);
		if (!document?.name) continue;
		const text = telegramMessageAdapter.textFrom(message);

		const marker = telegramMarkerAdapter.fromCaption(text);
		if (marker) {
			// Don't skip a chunk for already having a part row: a half-finished mint
			// would then hide it on every later walk. healAndMint sorts that out.
			const { index, partChecksum, ...shared } = marker;
			const group = groupFor(shared);
			group.checksum ??= marker.checksum;
			group.metadata ??= marker.metadata;
			// A staged chunk is seen again by the walk: the same message, not another copy.
			if (!group.chunks.some((chunk) => chunk.tgMessageId === message.id)) {
				const repeated = group.chunks.some((chunk) => chunk.ord === index);
				(repeated ? group.repeats : group.chunks).push({
					ord: index,
					tgMessageId: message.id,
					sizeBytes: document.size,
					checksumSha256: partChecksum
				});
			}
			continue;
		}

		// Unmarked documents count only when they are zips.
		if (!isAllowedBackup(document.name, document.mimeType)) continue;
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

		// Each copy is a backup of its own. With one hidden, deleting the other would
		// report success and the backup would be back after a restart.
		for (const copy of [chunks, ...completeCopies(group.repeats, total)]) {
			// Trust the declared size only when the chunks add up to it.
			const sum = copy.reduce((bytes, chunk) => bytes + chunk.sizeBytes, 0);
			const finalSize = size > 0 && size === sum ? size : sum;
			const id = db.healAndMint({
				name,
				finalSize,
				mime,
				caption,
				checksum,
				metadata,
				chunks: copy
			});
			if (id) minted.push(id);
		}
		db.deletePendingByIdentity(name, size, total);
	}

	log.info(`group reconcile finished: ${minted.length} new backups indexed`);
	return minted;
}
