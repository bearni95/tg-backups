// @vitest-environment node
import { createHash } from 'node:crypto';
import { MtArgumentError } from '@mtcute/node';
import { describe, expect, it, vi } from 'vitest';
import { OnceAsync, Semaphore, sleep } from '../../src/lib/server/sync';
import { contentSha256, READ_BUFFER_BYTES } from '../../src/lib/server/telegram/backup';
import { BufferSource } from '../../src/lib/server/telegram/byte-source';
import { autoRetryDelayMs } from '../../src/lib/server/telegram/connection';
import {
	AbortControl,
	checkAbort,
	PauseControl,
	waitWhilePaused
} from '../../src/lib/server/telegram/controls';
import type { BackupGroup } from '../../src/lib/server/telegram/backup-group';
import { StorageError } from '../../src/lib/server/telegram/errors';
import { InvocationError, isTransient } from '../../src/lib/server/telegram/invocation-error';
import { multipartGroupKey } from '../../src/lib/server/telegram/reconcile';
import { toInvocationError } from '../../src/lib/server/telegram/transport';
import {
	BACKOFF_BASE_MS,
	BACKOFF_CAP_MS,
	chunkCount,
	MAX_CHUNK_BYTES,
	PART_BYTES,
	partModeFor,
	readPiece,
	retryDelayMs,
	SMALL_FILE_MAX_BYTES,
	stableGroupId
} from '../../src/lib/server/telegram/upload';
import {
	applyChunkProgress,
	buildChunkSnapshots,
	MAX_CONCURRENT_UPLOADS,
	UploadRegistry
} from '../../src/lib/server/telegram/uploads';
import { storedName } from '../../src/utils/telegram/backupName';

const MIB = 1024 * 1024;

describe('errors', () => {
	it.each([
		[StorageError.notAuthenticated(), 'not_authenticated', 401],
		[StorageError.passwordRequired(), 'password_required', 401],
		[StorageError.credentialsMissing(), 'credentials_missing', 400],
		[StorageError.loginInProgressMismatch(), 'login_in_progress_mismatch', 400],
		[StorageError.noLoginInProgress(), 'no_login_in_progress', 400],
		[StorageError.invalidCode(), 'invalid_code', 400],
		[StorageError.invalidPassword(), 'invalid_password', 400],
		[StorageError.badRequest('x'), 'bad_request', 400],
		[StorageError.notFound(), 'not_found', 404],
		[StorageError.groupNotFound(), 'group_not_found', 404],
		[StorageError.groupRequired(), 'group_required', 409],
		[StorageError.groupUnavailable(), 'group_unavailable', 409],
		[StorageError.backupIncomplete(), 'backup_incomplete', 409],
		[StorageError.uploadAborted(), 'upload_aborted', 409],
		[StorageError.fileTooLarge(10), 'file_too_large', 413],
		[StorageError.unsupportedMediaType('x', 'y'), 'unsupported_media_type', 415],
		[StorageError.checksumMismatch('a', 'b'), 'checksum_mismatch', 422],
		[StorageError.rateLimited(3), 'rate_limited', 429],
		[StorageError.telegram('x'), 'telegram_error', 500],
		[StorageError.database('x'), 'database_error', 500],
		[StorageError.io('x'), 'io_error', 500],
		[StorageError.internal('x'), 'internal', 500]
	])('%s is %s / %i', (error, code, status) => {
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
	});

	it('serialises details', () => {
		expect(StorageError.rateLimited(12).toJSON()).toMatchObject({
			code: 'rate_limited',
			retryAfterSeconds: 12
		});
		expect(StorageError.fileTooLarge(999).toJSON()).toMatchObject({
			code: 'file_too_large',
			limitBytes: 999
		});
		expect(StorageError.unsupportedMediaType('cover.jpg', 'image/jpeg').toJSON()).toMatchObject({
			name: 'cover.jpg',
			mime: 'image/jpeg'
		});
		expect(StorageError.checksumMismatch('abc', 'def').message).toMatch(/abc.*def/);
		expect(StorageError.telegram('network').message).toContain('network');
	});

	it('maps system, JSON, database and other errors', () => {
		const io = Object.assign(new Error('boom'), { code: 'ENOENT', syscall: 'open' });
		expect(StorageError.from(io).code).toBe('io_error');
		expect(StorageError.from(new SyntaxError('bad')).code).toBe('internal');
		const sqlite = Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR' });
		expect(StorageError.from(sqlite).code).toBe('database_error');
		expect(StorageError.from(new Error('oops')).code).toBe('internal');
	});

	it('maps Telegram errors', () => {
		const from = (code: number, text: string) => StorageError.from(InvocationError.rpc(code, text));
		expect(from(420, 'FLOOD_WAIT_7')).toMatchObject({
			code: 'rate_limited',
			details: { retryAfterSeconds: 7 }
		});
		expect(from(420, 'FLOOD_PREMIUM_WAIT_3').code).toBe('rate_limited');
		expect(from(401, 'AUTH_KEY_UNREGISTERED').code).toBe('not_authenticated');
		expect(from(401, 'SESSION_REVOKED').code).toBe('not_authenticated');
		expect(from(400, 'CHAT_WRITE_FORBIDDEN').code).toBe('telegram_error');
	});

	it('parses the number out of an RPC error', () => {
		const error = InvocationError.rpc(303, 'PHONE_MIGRATE_4');
		expect(error).toMatchObject({ rpcName: 'PHONE_MIGRATE', value: 4 });
		expect(InvocationError.rpc(400, 'PHONE_CODE_INVALID').matches('PHONE_CODE_*')).toBe(true);
		expect(InvocationError.rpc(400, 'A_TIMEOUT').matches('*_TIMEOUT')).toBe(true);
	});

	it('classifies what mtcute throws', () => {
		expect(toInvocationError(new MtArgumentError('bad')).kind).toBe('fatal');
		expect(toInvocationError(new Error('ECONNRESET')).kind).toBe('io');
	});
});

describe('retries', () => {
	it.each([
		[InvocationError.io('reset'), true],
		[InvocationError.dropped(), true],
		[InvocationError.transport('bad frame'), true],
		[InvocationError.rpc(420, 'FLOOD_WAIT_7'), true],
		[InvocationError.rpc(420, 'FLOOD_PREMIUM_WAIT_3'), true],
		[InvocationError.rpc(500, 'INTERNAL'), true],
		[InvocationError.rpc(500, 'RPC_CALL_FAIL'), true],
		[InvocationError.rpc(-503, 'Timeout'), true],
		[InvocationError.rpc(400, 'STORAGE_CHECK_TIMEOUT'), true],
		[InvocationError.rpc(400, 'FILE_PART_TOO_BIG'), false],
		[InvocationError.rpc(400, 'FILE_PARTS_INVALID'), false],
		[InvocationError.rpc(400, 'FILE_PART_SIZE_CHANGED'), false],
		[InvocationError.rpc(400, 'FILE_PART_EMPTY'), false],
		[InvocationError.rpc(401, 'AUTH_KEY_UNREGISTERED'), false],
		[InvocationError.fatal('invalid dc'), false]
	])('%s transient: %s', (error, expected) => {
		expect(isTransient(error)).toBe(expected);
	});

	it('retries any call once for a short flood or a blip only', () => {
		expect(autoRetryDelayMs(InvocationError.rpc(420, 'FLOOD_WAIT_60'))).toBe(60_000);
		expect(autoRetryDelayMs(InvocationError.rpc(420, 'FLOOD_WAIT_61'))).toBeNull();
		expect(autoRetryDelayMs(InvocationError.io('reset'))).toBe(1000);
		expect(autoRetryDelayMs(InvocationError.rpc(500, 'INTERNAL'))).toBeNull();
	});

	it('honours flood waits', () => {
		expect(retryDelayMs(StorageError.rateLimited(7), 0)).toBe(7000);
		expect(retryDelayMs(StorageError.rateLimited(7), 5)).toBe(7000);
	});

	it('otherwise backs off exponentially to a cap', () => {
		const error = StorageError.telegram('transient');
		expect(retryDelayMs(error, 0)).toBe(BACKOFF_BASE_MS);
		expect(retryDelayMs(error, 1)).toBe(BACKOFF_BASE_MS * 2);
		expect(retryDelayMs(error, 2)).toBe(BACKOFF_BASE_MS * 4);
		expect(retryDelayMs(error, 20)).toBe(BACKOFF_CAP_MS);
	});
});

describe('chunking', () => {
	it.each([
		[0, 1],
		[MAX_CHUNK_BYTES - 1, 1],
		[MAX_CHUNK_BYTES, 1],
		[MAX_CHUNK_BYTES + 1, 2],
		[175 * MIB, 4]
	])('%i bytes is %i chunks', (size, count) => {
		expect(chunkCount(size)).toBe(count);
	});

	it('switches method above 10 MiB', () => {
		expect(partModeFor(0)).toBe('big');
		expect(partModeFor(1)).toBe('small');
		expect(partModeFor(SMALL_FILE_MAX_BYTES)).toBe('small');
		expect(partModeFor(SMALL_FILE_MAX_BYTES + 1)).toBe('big');
		expect(partModeFor(MAX_CHUNK_BYTES)).toBe('big');
		expect(MAX_CHUNK_BYTES / PART_BYTES).toBe(100);
	});

	it('derives the group id already on Telegram', () => {
		// sha256(name, NUL, size as u64 little-endian)
		expect(stableGroupId('Mulan', 1_392_198_638)).toBe(
			'b879b1988a2224121b678ae1d56d52013c73f5ccfa2efcaa444c891532273729'
		);
		expect(stableGroupId('Mulan', 1_392_198_639)).not.toBe(stableGroupId('Mulan', 1_392_198_638));
		expect(stableGroupId('Mulan 2', 1_392_198_638)).not.toBe(stableGroupId('Mulan', 1_392_198_638));
	});

	it('keys groups on name, size and total', () => {
		const key = multipartGroupKey('Mulan', 1_392_198_638, 27);
		expect(multipartGroupKey('Mulan', 1_392_198_638, 27)).toBe(key);
		expect(multipartGroupKey('Mulan 2', 1_392_198_638, 27)).not.toBe(key);
		expect(multipartGroupKey('Mulan', 1_392_198_639, 27)).not.toBe(key);
		expect(multipartGroupKey('Mulan', 1_392_198_638, 28)).not.toBe(key);
	});

	it('reads exact pieces and fails on a short one', async () => {
		const source = new BufferSource(Buffer.from([9, 8, 7, 6]));
		expect([...(await readPiece(source, 3))]).toEqual([9, 8, 7]);
		await expect(readPiece(source, 3)).rejects.toMatchObject({ code: 'bad_request' });
	});
});

describe('content hash', () => {
	it('gives other content another identity', async () => {
		const a = await contentSha256(new BufferSource(Buffer.from('monday')), 6);
		const b = await contentSha256(new BufferSource(Buffer.from('friday')), 6);
		expect(storedName('db.zip', a)).not.toBe(storedName('db.zip', b));
	});

	it('spans buffers and restores the cursor', async () => {
		const bytes = Buffer.alloc(READ_BUFFER_BYTES * 2 + 3, 7);
		const source = new BufferSource(bytes);
		expect(await contentSha256(source, bytes.length)).toBe(
			createHash('sha256').update(bytes).digest('hex')
		);
		expect(source.position).toBe(0);
	});

	it('can be cancelled', async () => {
		const abort = new AbortControl();
		abort.abort();
		await expect(contentSha256(new BufferSource(Buffer.alloc(8)), 8, abort)).rejects.toMatchObject({
			code: 'upload_aborted'
		});
	});
});

describe('controls', () => {
	it('pauses and resumes', () => {
		const pause = new PauseControl();
		expect(pause.isPaused).toBe(false);
		pause.pause();
		expect(pause.isPaused).toBe(true);
		pause.resume();
		expect(pause.isPaused).toBe(false);
	});

	it('aborts', () => {
		const abort = new AbortControl();
		expect(() => checkAbort(abort)).not.toThrow();
		abort.abort();
		expect(() => checkAbort(abort)).toThrow('aborted');
		expect(() => checkAbort()).not.toThrow();
	});

	it('waits while paused', async () => {
		await waitWhilePaused();
		const pause = new PauseControl();
		pause.pause();
		let finished = false;
		const waiting = waitWhilePaused(pause).then(() => (finished = true));
		await sleep(30);
		expect(finished).toBe(false);
		pause.resume();
		await waiting;
		expect(finished).toBe(true);
	});

	it('queues FIFO', async () => {
		const gate = new Semaphore();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) =>
				gate.run(async () => {
					await sleep(5);
					order.push(n);
				})
			)
		);
		expect(order).toEqual([1, 2, 3]);
	});

	it('retries a failed once-cell and keeps a success', async () => {
		const once = new OnceAsync<number>();
		await expect(once.run(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
		expect(await once.run(async () => 5)).toEqual({ value: 5, ran: true });
		expect(await once.run(async () => 6)).toEqual({ value: 5, ran: false });
	});
});

describe('upload registry', () => {
	const job = (name = 'a.zip') => ({
		path: `/data/${name}`,
		name,
		mimeType: 'application/zip',
		totalBytes: 100,
		refId: 'ref',
		group: { id: 'channel-1', title: 'One' } as BackupGroup
	});
	const done = { id: 'file', tgMessageId: 1, sha256: null };

	it('starts empty and says no for unknown ids', () => {
		const registry = new UploadRegistry(async () => done);
		expect(registry.list()).toEqual([]);
		expect(registry.get('nope')).toBeNull();
		expect(registry.pause('nope')).toBe(false);
		expect(registry.resume('nope')).toBe(false);
		expect(registry.cancel('nope')).toBe(false);
	});

	it('runs one upload at a time', async () => {
		expect(MAX_CONCURRENT_UPLOADS).toBe(1);
		const waiting: (() => void)[] = [];
		const registry = new UploadRegistry(
			() => new Promise((resolve) => waiting.push(() => resolve(done)))
		);
		const first = registry.spawn(job('a.zip'));
		const second = registry.spawn(job('b.zip'));
		expect(first.transferStartedAt).toBeNull();

		await vi.waitFor(() => expect(waiting).toHaveLength(1));
		expect(registry.get(second.uploadId)).toMatchObject({
			status: 'running',
			transferStartedAt: null
		});
		waiting[0]();
		await vi.waitFor(() => expect(waiting).toHaveLength(2));
		expect(registry.get(first.uploadId)).toMatchObject({
			status: 'completed',
			fileId: 'file',
			bytesUploaded: 100
		});
		waiting[1]();
	});

	it('cancels a queued upload without running it', async () => {
		let release = () => {};
		const upload = vi.fn(
			() => new Promise<typeof done>((resolve) => (release = () => resolve(done)))
		);
		const registry = new UploadRegistry(upload);
		registry.spawn(job('a.zip'));
		const queued = registry.spawn(job('b.zip'));
		await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
		registry.cancel(queued.uploadId);
		release();
		await vi.waitFor(() => expect(registry.get(queued.uploadId)?.status).toBe('cancelled'));
		expect(upload).toHaveBeenCalledTimes(1);
	});

	it('flips status on pause and resume', () => {
		const registry = new UploadRegistry(() => new Promise(() => {}));
		const { uploadId } = registry.spawn(job());
		expect(registry.pause(uploadId)).toBe(true);
		expect(registry.get(uploadId)?.status).toBe('paused');
		expect(registry.resume(uploadId)).toBe(true);
		expect(registry.get(uploadId)?.status).toBe('running');
	});

	it('reports failures', async () => {
		const registry = new UploadRegistry(async () =>
			Promise.reject(StorageError.notAuthenticated())
		);
		const { uploadId } = registry.spawn(job());
		await vi.waitFor(() =>
			expect(registry.get(uploadId)).toMatchObject({ status: 'failed', error: 'not authenticated' })
		);
	});

	it('counts skipped chunks apart', async () => {
		const registry = new UploadRegistry(async (_path, request) => {
			request.onChunk?.({
				chunkIndex: 0,
				chunkSizeBytes: 100,
				bytesUploaded: 100,
				completedCount: 1,
				skipped: true
			});
			return done;
		});
		const { uploadId } = registry.spawn(job());
		await vi.waitFor(() => expect(registry.get(uploadId)?.status).toBe('completed'));
		expect(registry.get(uploadId)?.skippedBytes).toBe(100);
	});

	it('sorts by start time', () => {
		const registry = new UploadRegistry(() => new Promise(() => {}));
		const clock = vi.spyOn(Date, 'now').mockReturnValue(200_000);
		const later = registry.spawn(job('later.zip'));
		clock.mockReturnValue(100_000);
		const earlier = registry.spawn(job('earlier.zip'));
		clock.mockRestore();
		expect(registry.list().map((upload) => upload.uploadId)).toEqual([
			earlier.uploadId,
			later.uploadId
		]);
	});

	it('splits chunk snapshots at 50 MiB', () => {
		const chunks = buildChunkSnapshots(MAX_CHUNK_BYTES * 2 + 1234, 3);
		expect(chunks.map((chunk) => chunk.bytesTotal)).toEqual([
			MAX_CHUNK_BYTES,
			MAX_CHUNK_BYTES,
			1234
		]);
		expect(chunks.every((chunk) => chunk.status === 'pending' && chunk.bytesUploaded === 0)).toBe(
			true
		);
		expect(buildChunkSnapshots(1234, 1)).toHaveLength(1);
		expect(buildChunkSnapshots(100, 0)).toEqual([]);
	});

	it('advances only the named chunk, clamped', () => {
		const registry = new UploadRegistry(() => new Promise(() => {}));
		const snapshot = registry.spawn({ ...job(), totalBytes: MAX_CHUNK_BYTES * 3 });
		applyChunkProgress(snapshot, 1, 1024);
		expect(snapshot.chunks.map((chunk) => chunk.status)).toEqual(['pending', 'running', 'pending']);
		expect(snapshot.chunks[1].bytesUploaded).toBe(1024);
		applyChunkProgress(snapshot, 1, MAX_CHUNK_BYTES * 9);
		expect(snapshot.chunks[1].bytesUploaded).toBe(MAX_CHUNK_BYTES);
	});
});
