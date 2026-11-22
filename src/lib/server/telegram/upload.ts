// Chunked, resumable upload of one logical file into the group.
//
// A file becomes one Telegram document per 50 MiB chunk, each captioned with a
// `tgb-multipart` marker. Chunks go in order, so the full-file hash streams in
// order; within a chunk up to 8 parts of 512 KiB fly at once, so memory stays
// around 4 MiB whatever the file size. On resume, chunks already on Telegram
// are seeked past without reading, which is why a resumed file has no checksum.
import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { Long, tl } from '@mtcute/node';
import { log } from '$lib/server/logger';
import { sleep } from '$lib/server/sync';
import { telegramMarkerAdapter } from '$adapters/classes/telegram-marker.adapter';
import { stringifyCanonical } from '$utils/json/losslessJson';
import type { PeerRef } from '$types/telegram-server.type';
import type { ByteSource } from './byte-source';
import { randomLong, sendDocument } from './chat';
import type { Connection } from './connection';
import { checkAbort, waitWhilePaused, type AbortControl, type PauseControl } from './controls';
import type { IndexDb } from './db';
import { StorageError } from './errors';
import { isTransient } from './invocation-error';

export const MAX_UPLOAD_BYTES = 200 * 1024 ** 3;
export const MAX_CHUNK_BYTES = 50 * 1024 * 1024;
/** Telegram's limit for one part; 50 MiB is 100 of them, well under its 4000. */
export const PART_BYTES = 512 * 1024;
/** Up to here Telegram wants `saveFilePart` with an MD5 instead of `saveBigFilePart`. */
export const SMALL_FILE_MAX_BYTES = 10 * 1024 * 1024;

const PART_CONCURRENCY = 8;
const MAX_PART_RETRIES = 5;
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 15_000;
const PART_TIMEOUT_MS = 300_000;

export interface UploadProgress {
	/** Across the whole file. Never goes backwards. */
	bytesUploaded: number;
	chunkIndex: number;
	chunkBytesUploaded: number;
}

export interface ChunkCompletion {
	chunkIndex: number;
	chunkSizeBytes: number;
	bytesUploaded: number;
	completedCount: number;
	/** Already on Telegram: excluded from speed, as it never crossed the wire. */
	skipped: boolean;
}

export interface UploadRequest {
	name: string;
	mimeType: string;
	totalSize: number;
	/** Opaque JSON. Undefined is none; null is stored as `null`. */
	metadata?: unknown;
	text?: string;
	onProgress?: (progress: UploadProgress) => void;
	onChunk?: (chunk: ChunkCompletion) => void;
	pause?: PauseControl;
	abort?: AbortControl;
}

export interface UploadResult {
	id: string;
	tgMessageId: number;
	/** Null after a resume, which didn't see every byte. */
	sha256: string | null;
}

export function chunkCount(totalSize: number): number {
	return Math.max(1, Math.ceil(totalSize / MAX_CHUNK_BYTES));
}

/**
 * Derived from the identity a resume matches on, so every attempt at a file
 * tags its chunks with the same group id.
 */
export function stableGroupId(name: string, totalSize: number): string {
	const size = Buffer.alloc(8);
	size.writeBigUInt64LE(BigInt(totalSize));
	return createHash('sha256').update(name).update(Buffer.alloc(1)).update(size).digest('hex');
}

export type PartMode = 'small' | 'big';

export function partModeFor(chunkSize: number): PartMode {
	// An empty file keeps the big path: one empty part.
	return chunkSize === 0 || chunkSize > SMALL_FILE_MAX_BYTES ? 'big' : 'small';
}

export function retryDelayMs(error: StorageError, attempt: number): number {
	if (error.code === 'rate_limited') return (error.details.retryAfterSeconds ?? 0) * 1000;
	return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(attempt, 8), BACKOFF_CAP_MS);
}

export async function readPiece(source: ByteSource, length: number): Promise<Buffer> {
	const piece = await source.read(length);
	if (piece.length < length) {
		throw StorageError.badRequest(
			`upload reader ended early: wanted ${length} more bytes, got ${piece.length}`
		);
	}
	return piece;
}

interface Attempt {
	connection: Connection;
	target: PeerRef;
	request: UploadRequest;
	groupId: string;
	totalChunks: number;
	bytesUploaded: number;
}

export async function upload(
	connection: Connection,
	db: IndexDb,
	request: UploadRequest,
	source: ByteSource
): Promise<UploadResult> {
	const { name, totalSize, abort } = request;
	if (totalSize > MAX_UPLOAD_BYTES) throw StorageError.fileTooLarge(MAX_UPLOAD_BYTES);

	const target = await connection.targetPeer();
	const attempt: Attempt = {
		connection,
		target,
		request,
		groupId: stableGroupId(name, totalSize),
		totalChunks: chunkCount(totalSize),
		bytesUploaded: 0
	};

	const resumable = db.findResumable(name, totalSize);
	const id = resumable?.id ?? randomUUID();
	const existing = new Map(
		resumable ? db.listParts(resumable.id).map((part) => [part.ord, part]) : []
	);
	if (resumable) {
		log.info(
			`resuming ${JSON.stringify(name)}: ${existing.size}/${attempt.totalChunks} chunks already on Telegram`
		);
	}

	const metadata = request.metadata === undefined ? null : stringifyCanonical(request.metadata);
	const fullHash = createHash('sha256');
	// False as soon as any byte skips the hash, as a seeked-past chunk does.
	let fullHashValid = true;
	let headWritten = resumable !== null;
	let headMessageId: number | null = null;
	let completed = 0;
	let remaining = totalSize;

	await connection.ensureUploadPool();

	for (let index = 0; index < attempt.totalChunks; index++) {
		checkAbort(abort);
		const size = Math.min(remaining, MAX_CHUNK_BYTES);
		const landed = existing.get(index);

		if (landed?.sizeBytes === size) {
			source.position += size;
			fullHashValid = false;
			remaining -= size;
			attempt.bytesUploaded += size;
			if (index === 0) headMessageId = landed.tgMessageId;
			completed += 1;
			request.onChunk?.({
				chunkIndex: index,
				chunkSizeBytes: size,
				bytesUploaded: attempt.bytesUploaded,
				completedCount: completed,
				skipped: true
			});
			continue;
		}
		// A stale row of the wrong size: push the chunk again.
		if (landed) fullHashValid = false;

		const sent = await uploadChunk(attempt, source, index, size, fullHashValid ? fullHash : null);
		remaining -= size;

		if (!headWritten) {
			db.insert({
				id,
				name,
				sizeBytes: totalSize,
				mimeType: request.mimeType,
				tgMessageId: sent.messageId,
				text: request.text ?? null,
				checksumSha256: null,
				metadata
			});
			headWritten = true;
		} else if (index === 0) {
			db.updateHeadMessageId(id, sent.messageId);
		}
		if (index === 0) headMessageId = sent.messageId;
		db.insertPart(id, {
			ord: index,
			tgMessageId: sent.messageId,
			sizeBytes: size,
			checksumSha256: sent.sha256
		});

		completed += 1;
		request.onChunk?.({
			chunkIndex: index,
			chunkSizeBytes: size,
			bytesUploaded: attempt.bytesUploaded,
			completedCount: completed,
			skipped: false
		});
	}

	let sha256: string | null = null;
	if (fullHashValid) {
		sha256 = fullHash.digest('hex');
		db.setChecksum(id, sha256);
	}
	if (headMessageId === null) throw StorageError.internal('chunked upload produced zero chunks');

	log.info(`upload finished for ${JSON.stringify(name)} (${attempt.totalChunks} chunks)`);
	return { id, tgMessageId: headMessageId, sha256 };
}

async function uploadChunk(
	attempt: Attempt,
	source: ByteSource,
	index: number,
	size: number,
	fullHash: Hash | null
): Promise<{ messageId: number; sha256: string }> {
	const { connection, request, totalChunks } = attempt;
	const { abort, pause } = request;

	const fileId = randomLong();
	const parts = Math.max(1, Math.ceil(size / PART_BYTES));
	const mode = partModeFor(size);
	const chunkHash = createHash('sha256');
	const md5 = mode === 'small' ? createHash('md5') : null;

	const inFlight = new Set<Promise<void>>();
	let failure: { error: unknown } | null = null;
	// Read through functions, as both change while the loop awaits.
	const throwIfFailed = () => {
		if (failure) throw failure.error;
	};
	let given = false;
	const givenUp = () => given;
	let chunkUploaded = 0;

	const dispatch = (part: number, bytes: Buffer) => {
		const task = savePartWithRetry(
			connection,
			{ mode, fileId, part, parts, bytes },
			{ pause, abort, givenUp }
		)
			.then(() => {
				if (givenUp() || bytes.length === 0) return;
				chunkUploaded += bytes.length;
				attempt.bytesUploaded += bytes.length;
				request.onProgress?.({
					bytesUploaded: attempt.bytesUploaded,
					chunkIndex: index,
					chunkBytesUploaded: chunkUploaded
				});
			})
			.catch((error: unknown) => {
				failure ??= { error };
			})
			.finally(() => inFlight.delete(task));
		inFlight.add(task);
	};

	try {
		for (let part = 0; part < parts;) {
			checkAbort(abort);
			throwIfFailed();
			if (inFlight.size >= PART_CONCURRENCY) {
				await Promise.race(inFlight);
				continue;
			}
			await waitWhilePaused(pause);
			checkAbort(abort);

			const piece = await readPiece(source, Math.min(size - part * PART_BYTES, PART_BYTES));
			chunkHash.update(piece);
			fullHash?.update(piece);
			md5?.update(piece);
			dispatch(part, piece);
			part += 1;
		}
		while (inFlight.size > 0) {
			checkAbort(abort);
			throwIfFailed();
			await Promise.race(inFlight);
		}
		throwIfFailed();
		checkAbort(abort);
	} finally {
		// Stops sibling retries once the chunk has failed.
		given = true;
	}

	const { name, mimeType, totalSize, text, metadata } = request;
	const chunkName = totalChunks === 1 ? name : `${name}.part${index + 1}of${totalChunks}`;
	const file: tl.RawInputFile | tl.RawInputFileBig = md5
		? { _: 'inputFile', id: fileId, parts, name: chunkName, md5Checksum: md5.digest('hex') }
		: { _: 'inputFileBig', id: fileId, parts, name: chunkName };

	const sha256 = chunkHash.digest('hex');
	const caption = telegramMarkerAdapter.toCaption({
		groupId: attempt.groupId,
		index,
		total: totalChunks,
		name,
		size: totalSize,
		mime: mimeType,
		caption: text ?? null,
		// Unknown until the last chunk, so markers never carry it.
		checksum: null,
		partChecksum: sha256,
		metadata
	});
	return { messageId: await sendDocument(connection, attempt.target, file, caption), sha256 };
}

async function savePartWithRetry(
	connection: Connection,
	save: { mode: PartMode; fileId: Long; part: number; parts: number; bytes: Buffer },
	control: { pause?: PauseControl; abort?: AbortControl; givenUp: () => boolean }
): Promise<void> {
	const { mode, fileId, part, parts, bytes } = save;
	const method = mode === 'big' ? 'saveBigFilePart' : 'saveFilePart';
	const options = { pool: connection.uploadConnection, timeoutMs: PART_TIMEOUT_MS };

	for (let retry = 0; ; retry++) {
		if (control.givenUp()) return;
		checkAbort(control.abort);
		await waitWhilePaused(control.pause);

		try {
			const saved =
				mode === 'big'
					? await connection.invoke(
							{
								_: 'upload.saveBigFilePart',
								fileId,
								filePart: part,
								fileTotalParts: parts,
								bytes
							},
							options
						)
					: await connection.invoke(
							{ _: 'upload.saveFilePart', fileId, filePart: part, bytes },
							options
						);
			if (saved) return;
			// "Stored data is bad": the same bytes won't fix it.
			throw StorageError.telegram(`${method}(${fileId}, part=${part}) returned false`);
		} catch (error) {
			const mapped = StorageError.from(error);
			if (!isTransient(error) || retry >= MAX_PART_RETRIES) throw mapped;
			const delay = retryDelayMs(mapped, retry);
			log.warn(
				`${method} part ${part} attempt ${retry + 1} failed: ${mapped.message}; retrying in ${delay} ms`
			);
			await sleep(delay);
		}
	}
}
