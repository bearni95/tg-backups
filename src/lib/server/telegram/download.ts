import { log } from '$lib/server/logger';
import { telegramMessageAdapter } from '$adapters/classes/telegram-message.adapter';
import type { FilePart, FileRow, PeerRef, StoredDocument } from '$types/telegram-server.type';
import {
	deleteAndConfirm,
	deleteMessages,
	getMessagesById,
	iterateHistory,
	MESSAGES_PER_CALL
} from './chat';
import type { Connection } from './connection';
import type { BackupGroup } from './backup-group';
import { StorageError } from './errors';
import { InvocationError } from './invocation-error';
import { chunkCount } from './upload';

/** getFile offsets must be multiples of this. */
const CHUNK_BYTES = 512 * 1024;
const GET_FILE_TIMEOUT_MS = 120_000;
const MAX_MIGRATIONS = 5;

/**
 * The inclusive range `[start, end]` of a backup. Everything that can fail
 * before the first byte fails here, before any response headers go out.
 */
export async function downloadRange(
	{ connection, db, peer: target }: BackupGroup,
	row: FileRow,
	start: number,
	end: number
): Promise<AsyncGenerator<Uint8Array>> {
	if (start > end) return (async function* () {})();
	// A backup cut short must never restore as a shorter, valid-looking zip.
	if (!db.isComplete(row)) throw StorageError.backupIncomplete();

	let parts = db.listParts(row.id);
	if (parts.length === 0) {
		parts = [
			{ ord: 0, tgMessageId: row.tgMessageId, sizeBytes: row.sizeBytes, checksumSha256: null }
		];
	}

	const ids = parts.map((part) => part.tgMessageId);
	for (let i = 0; i < ids.length; i += MESSAGES_PER_CALL) {
		const batch = await getMessagesById(connection, target, ids.slice(i, i + MESSAGES_PER_CALL));
		if (batch.includes(null)) throw StorageError.notFound();
	}

	const length = Math.min(end - start + 1, Math.max(0, row.sizeBytes - start));
	return streamParts(connection, target, parts, start, length);
}

async function* streamParts(
	connection: Connection,
	target: PeerRef,
	parts: FilePart[],
	start: number,
	length: number
): AsyncGenerator<Uint8Array> {
	let offset = 0;
	let remaining = length;

	for (const part of parts) {
		if (remaining === 0) break;
		const partSize = Math.max(0, part.sizeBytes);
		const partStart = offset;
		offset += partSize;
		if (start >= offset) continue;

		const localStart = Math.max(0, start - partStart);
		let wanted = Math.min(partSize - localStart, remaining);
		if (wanted === 0) continue;

		// Fetched only now: file references expire, and a big restore outlasts them.
		const [message] = await getMessagesById(connection, target, [part.tgMessageId]);
		if (!message) throw StorageError.notFound();
		const document = telegramMessageAdapter.documentFrom(message);
		if (!document) throw StorageError.internal('stored message has no media payload');

		let drop = localStart % CHUNK_BYTES;
		for await (const bytes of downloadDocument(connection, document, localStart - drop)) {
			const dropped = Math.min(drop, bytes.length);
			drop -= dropped;
			const piece = bytes.subarray(dropped, dropped + wanted);
			if (piece.length === 0) continue;
			wanted -= piece.length;
			remaining -= piece.length;
			yield piece;
			if (wanted === 0) break;
		}
		// Keep short parts from shifting every byte after them.
		if (wanted > 0) break;
	}

	// Fail loudly: Content-Length already promised the full range, and ending
	// cleanly would leave the browser waiting or saving a truncated zip.
	if (remaining > 0) {
		throw StorageError.internal(`Telegram returned ${remaining} bytes fewer than expected`);
	}
}

async function* downloadDocument(
	connection: Connection,
	document: StoredDocument,
	from: number
): AsyncGenerator<Uint8Array> {
	let dcId = document.dcId;
	let offset = from;
	let migrations = 0;
	for (;;) {
		try {
			const file = await connection.invoke(
				{ _: 'upload.getFile', location: document.location, offset, limit: CHUNK_BYTES },
				{ dcId, pool: 'download', timeoutMs: GET_FILE_TIMEOUT_MS }
			);
			if (file._ !== 'upload.file') {
				throw StorageError.telegram('getFile returned a CDN redirect, which was not requested');
			}
			if (file.bytes.length === 0) return;
			yield file.bytes;
			if (file.bytes.length < CHUNK_BYTES) return;
			offset += CHUNK_BYTES;
		} catch (error) {
			if (
				InvocationError.is(error) &&
				error.code === 303 &&
				error.value !== null &&
				migrations < MAX_MIGRATIONS
			) {
				migrations += 1;
				dcId = error.value;
				continue;
			}
			throw error;
		}
	}
}

/**
 * Delete one backup. The index only forgets what Telegram confirms is gone, and
 * stops at the first refusal, so a refused delete leaves the backup whole.
 */
export async function deleteFile(
	{ connection, db, peer }: BackupGroup,
	row: FileRow
): Promise<void> {
	const ids = db.listParts(row.id).map((part) => part.tgMessageId);
	if (ids.length === 0) ids.push(row.tgMessageId);

	let done = 0;
	for (let i = 0; i < ids.length; i += MESSAGES_PER_CALL) {
		const batch = ids.slice(i, i + MESSAGES_PER_CALL);
		const { deleted, remaining, error } = await deleteAndConfirm(connection, peer, batch);
		db.forgetMessages(deleted);
		done += deleted.length;
		if (remaining.length > 0) throw StorageError.deleteFailed(ids.length - done, ids.length, error);
	}

	// An interrupted backup may be staged. Left behind, those dead message ids
	// would be fused into a re-upload of the same zip.
	db.deletePendingByIdentity(row.name, row.sizeBytes, chunkCount(Math.max(0, row.sizeBytes)));
	db.delete(row.id);
}

/**
 * Delete everything in the group and return how many messages went. Service
 * messages ("group created") are best effort: Telegram won't delete all of them.
 */
export async function deleteAll({ connection, db, peer: target }: BackupGroup): Promise<number> {
	const ids: number[] = [];
	const serviceIds: number[] = [];
	for await (const message of iterateHistory(connection, target)) {
		if (message._ === 'message') ids.push(message.id);
		else if (message._ === 'messageService') serviceIds.push(message.id);
	}

	let left = 0;
	let cause: unknown = null;
	for (let i = 0; i < ids.length; i += MESSAGES_PER_CALL) {
		const batch = ids.slice(i, i + MESSAGES_PER_CALL);
		const { deleted, remaining, error } = await deleteAndConfirm(connection, target, batch);
		db.forgetMessages(deleted);
		left += remaining.length;
		if (remaining.length > 0) cause ??= error;
	}

	// Apart, or one of them would fail a whole batch of backups.
	for (let i = 0; i < serviceIds.length; i += MESSAGES_PER_CALL) {
		try {
			await deleteMessages(connection, target, serviceIds.slice(i, i + MESSAGES_PER_CALL));
		} catch (error) {
			log.info(`service messages left in the group: ${StorageError.from(error).message}`);
		}
	}

	if (left > 0) throw StorageError.deleteFailed(left, ids.length, cause);
	db.clearAll();
	log.info(`deleted all ${ids.length} messages from the group`);
	return ids.length;
}
