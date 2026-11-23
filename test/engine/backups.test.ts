// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { telegramMarkerAdapter } from '../../src/adapters/classes/telegram-marker.adapter';
import { BufferSource } from '../../src/lib/telegram/byte-source';
import { PauseControl, AbortControl } from '../../src/lib/telegram/controls';
import { InvocationError } from '../../src/lib/telegram/invocation-error';
import { reconcileIndex, walkAndMint } from '../../src/lib/telegram/reconcile';
import type { BackupGroup } from '../../src/lib/telegram/backup-group';
import { MAX_CHUNK_BYTES, PART_BYTES } from '../../src/lib/telegram/upload';
import type { UploadRequest } from '../../src/lib/telegram/upload';
import { useBackend } from './support/harness';

const backend = useBackend();

const MIB = 1024 * 1024;
const LONG = { timeout: 60_000 };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function pattern(size: number, seed = 1): Buffer {
	const block = Buffer.alloc(65_521);
	for (let i = 0; i < block.length; i++) block[i] = (i * 31 + seed * 17 + (i >> 8)) & 0xff;
	return Buffer.alloc(size, block);
}

function upload(storage: BackupGroup, bytes: Buffer, change: Partial<UploadRequest> = {}) {
	return storage.files.uploadSource(
		{ name: 'db.zip', mimeType: 'application/zip', totalSize: bytes.length, ...change },
		new BufferSource(bytes)
	);
}

async function restore(storage: BackupGroup, id: string, start?: number, end?: number) {
	const stream =
		start === undefined
			? await storage.files.download(id)
			: await storage.files.downloadRange(id, start, end!);
	const pieces: Uint8Array[] = [];
	for await (const piece of stream) pieces.push(piece);
	return Buffer.concat(pieces);
}

// toEqual on megabytes is very slow.
function expectSameBytes(actual: Buffer, expected: Buffer) {
	expect(actual.length).toBe(expected.length);
	expect(actual.equals(expected)).toBe(true);
}

async function otherMachine() {
	const root = join(backend.root, 'other-machine');
	mkdirSync(root, { recursive: true });
	return backend.group(root);
}

function chunkCaption(index: number, total: number, size: number, metadata?: unknown) {
	return telegramMarkerAdapter.toCaption({
		groupId: `attempt-${index}`,
		index,
		total,
		name: 'split.tgb-0123456789ab.zip',
		size,
		mime: 'application/zip',
		caption: null,
		checksum: null,
		partChecksum: null,
		metadata
	});
}

describe('upload and restore', () => {
	it.each([0, 1, PART_BYTES, PART_BYTES + 1, 3 * MIB + 7])('round-trips %i bytes', async (size) => {
		const storage = await backend.group();
		const bytes = pattern(size);
		const result = await upload(storage, bytes);

		expect(result.sha256).toBe(sha256(bytes));
		expect(storage.db.get(result.id)).toMatchObject({
			name: `db.tgb-${sha256(bytes).slice(0, 12)}.zip`,
			sizeBytes: size,
			checksumSha256: sha256(bytes)
		});
		expectSameBytes(await restore(storage, result.id), bytes);
		await storage.files.verify(result.id);
	});

	it('uses the big-file method above 10 MiB', LONG, async () => {
		const storage = await backend.group();
		const bytes = pattern(10 * MIB + 1);
		const { id } = await upload(storage, bytes);
		expect(backend.telegram.count('upload.saveFilePart')).toBe(0);
		expect(backend.telegram.count('upload.saveBigFilePart')).toBe(21);
		expect(
			backend.telegram.calls.find((c) => c.request._ === 'upload.saveBigFilePart')?.options.pool
		).toBe('upload');
		expectSameBytes(await restore(storage, id), bytes);
	});

	it('splits at 50 MiB and restores across the seam', LONG, async () => {
		const storage = await backend.group();
		const bytes = pattern(MAX_CHUNK_BYTES + 3);
		const progress: number[] = [];
		const { id } = await upload(storage, bytes, {
			onProgress: (event) => progress.push(event.bytesUploaded)
		});

		expect(storage.db.listParts(id).map((part) => part.sizeBytes)).toEqual([MAX_CHUNK_BYTES, 3]);
		const names = backend.telegram
			.requests('messages.sendMedia')
			.map((request) => (request.media as { file: { name: string } }).file.name);
		const stored = storage.db.get(id)!.name;
		expect(names).toEqual([`${stored}.part1of2`, `${stored}.part2of2`]);
		expect(progress.at(-1)).toBe(bytes.length);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));

		expectSameBytes(await restore(storage, id), bytes);
		const from = MAX_CHUNK_BYTES - 5;
		expectSameBytes(await restore(storage, id, from, bytes.length - 1), bytes.subarray(from));
	});

	it('restores unaligned ranges', async () => {
		const storage = await backend.group();
		const bytes = pattern(2 * MIB + 100);
		const { id } = await upload(storage, bytes);
		for (const [start, end] of [
			[0, 0],
			[1, 2],
			[PART_BYTES - 1, PART_BYTES],
			[700_001, 1_900_003],
			[bytes.length - 1, bytes.length - 1]
		]) {
			expectSameBytes(await restore(storage, id, start, end), bytes.subarray(start, end + 1));
		}
	});

	it('never flies more than 8 parts at once', async () => {
		const storage = await backend.group();
		let active = 0;
		let most = 0;
		backend.telegram.intercept = async (request) => {
			if (request._ !== 'upload.saveFilePart') return;
			most = Math.max(most, ++active);
			await new Promise((resolve) => setTimeout(resolve, 2));
			active--;
		};
		await upload(storage, pattern(9 * MIB));
		expect(most).toBe(8);
	});

	it('captions every chunk with the marker', async () => {
		const storage = await backend.group();
		const bytes = pattern(10);
		await upload(storage, bytes, { metadata: { z: 1, a: 2 }, text: 'note' });
		const [caption] = backend.telegram.captions();
		expect(telegramMarkerAdapter.fromCaption(caption)).toMatchObject({
			index: 0,
			total: 1,
			size: 10,
			caption: 'note',
			checksum: null,
			partChecksum: sha256(bytes),
			metadata: { a: 2, z: 1 }
		});
		expect(caption).toContain('"metadata":{"a":2,"z":1}');
	});

	it('keeps versions with the same name and size apart', async () => {
		const storage = await backend.group();
		const monday = await upload(storage, Buffer.from('monday'));
		const friday = await upload(storage, Buffer.from('friday'));
		expect(monday.id).not.toBe(friday.id);
		expect((await restore(storage, monday.id)).toString()).toBe('monday');
		expect((await restore(storage, friday.id)).toString()).toBe('friday');
	});

	it('removes what landed when the zip changed mid-upload', async () => {
		const storage = await backend.group();
		const bytes = pattern(100);
		backend.telegram.intercept = () => undefined;
		const source = new BufferSource(bytes);
		const read = source.read.bind(source);
		let reads = 0;
		source.read = async (length) => {
			const piece = await read(length);
			if (++reads > 1) piece.fill(0);
			return piece;
		};
		await expect(
			storage.files.uploadSource(
				{ name: 'db.zip', mimeType: 'application/zip', totalSize: 100 },
				source
			)
		).rejects.toMatchObject({ code: 'checksum_mismatch' });
		expect(storage.db.list()).toEqual([]);
		expect(backend.telegram.messages).toEqual([]);
	});

	it('retries a transient part failure', async () => {
		const storage = await backend.group();
		let failed = false;
		backend.telegram.intercept = (request) => {
			if (request._ === 'upload.saveFilePart' && !failed) {
				failed = true;
				throw InvocationError.rpc(500, 'INTERNAL');
			}
		};
		const { id } = await upload(storage, pattern(100));
		expect(backend.telegram.count('upload.saveFilePart')).toBe(2);
		expect(storage.db.isComplete(storage.db.get(id)!)).toBe(true);
	});

	it('fails fast on a permanent part failure', async () => {
		const storage = await backend.group();
		backend.telegram.intercept = (request) => {
			if (request._ === 'upload.saveFilePart') throw InvocationError.rpc(400, 'FILE_PART_TOO_BIG');
		};
		await expect(upload(storage, pattern(100))).rejects.toMatchObject({ code: 'telegram_error' });
		expect(backend.telegram.count('upload.saveFilePart')).toBe(1);
		expect(storage.db.list()).toEqual([]);
	});

	it('never records a chunk without its message id', async () => {
		const storage = await backend.group();
		const handle = backend.telegram.handle.bind(backend.telegram);
		backend.telegram.handle = async (request, options) => {
			const response = await handle(request, options);
			return request._ === 'messages.sendMedia' ? { _: 'updatesTooLong' } : response;
		};
		await expect(upload(storage, pattern(10))).rejects.toMatchObject({ code: 'telegram_error' });
		expect(storage.db.list()).toEqual([]);
	});

	it('falls back to the main connection', async () => {
		const storage = await backend.group();
		backend.telegram.intercept = (request) => {
			if (request._ === 'help.getConfig') throw InvocationError.transport('refused');
		};
		await upload(storage, pattern(10));
		expect(
			backend.telegram.calls.find((c) => c.request._ === 'upload.saveFilePart')?.options.pool
		).toBe('main');
	});

	it('cancels, also while paused', async () => {
		const storage = await backend.group();
		const pause = new PauseControl();
		const abort = new AbortControl();
		pause.pause();
		const running = upload(storage, pattern(100), { pause, abort });
		const rejected = expect(running).rejects.toMatchObject({ code: 'upload_aborted' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		abort.abort();
		pause.resume();
		await rejected;
		expect(backend.telegram.messages).toEqual([]);
	});

	it('refuses anything but a zip before uploading', async () => {
		const storage = await backend.group();
		await expect(
			upload(storage, Buffer.alloc(0), { name: 'cover.jpg', mimeType: 'image/jpeg' })
		).rejects.toMatchObject({ code: 'unsupported_media_type' });
		expect(backend.telegram.count('help.getConfig')).toBe(0);
	});

	it('refuses a directory', async () => {
		const storage = await backend.group();
		const request = { name: 'db.zip', mimeType: 'application/zip', totalSize: 0 };
		await expect(storage.files.uploadLocalFile(backend.root, request)).rejects.toMatchObject({
			code: 'bad_request'
		});
	});

	it('needs a group: there is no fallback', async () => {
		const storage = await backend.withoutGroup();
		await expect(storage.groups.resolve(null)).rejects.toMatchObject({ code: 'group_required' });
		expect(backend.telegram.count('messages.sendMedia')).toBe(0);
	});

	it('fails closed for a non-member', async () => {
		backend.telegram.member = false;
		await expect(backend.group()).rejects.toMatchObject({ code: 'group_unavailable' });
		expect(backend.telegram.count('messages.sendMedia')).toBe(0);
	});
});

describe('resume', () => {
	it('seeks past landed chunks', LONG, async () => {
		const storage = await backend.group();
		const bytes = pattern(MAX_CHUNK_BYTES + 3);
		backend.telegram.intercept = (request) => {
			if (request._ === 'upload.saveFilePart') throw InvocationError.rpc(400, 'FILE_PART_INVALID');
		};
		await expect(upload(storage, bytes)).rejects.toMatchObject({ code: 'telegram_error' });
		const [partial] = storage.db.list();
		expect(storage.db.isComplete(partial)).toBe(false);
		await expect(storage.files.download(partial.id)).rejects.toMatchObject({
			code: 'backup_incomplete'
		});

		backend.telegram.intercept = null;
		backend.telegram.calls = [];
		const skipped: boolean[] = [];
		const result = await upload(storage, bytes, {
			onChunk: (chunk) => skipped.push(chunk.skipped)
		});

		expect(result).toMatchObject({ id: partial.id, sha256: null });
		expect(skipped).toEqual([true, false]);
		expect(backend.telegram.count('upload.saveBigFilePart')).toBe(0);
		expect(backend.telegram.count('messages.sendMedia')).toBe(1);
		expectSameBytes(await restore(storage, result.id), bytes);
	});

	it('pushes a stale wrong-size chunk again', async () => {
		const storage = await backend.group();
		const bytes = pattern(1000);
		const name = `db.tgb-${sha256(bytes).slice(0, 12)}.zip`;
		storage.db.insert({
			id: 'stale',
			name,
			sizeBytes: 1000,
			mimeType: 'application/zip',
			tgMessageId: 900,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		storage.db.insertPart('stale', {
			ord: 0,
			tgMessageId: 900,
			sizeBytes: 10,
			checksumSha256: null
		});

		const result = await upload(storage, bytes);
		expect(result).toMatchObject({ id: 'stale', sha256: null });
		expect(storage.db.get('stale')?.tgMessageId).toBe(result.tgMessageId);
		expectSameBytes(await restore(storage, 'stale'), bytes);
	});

	it('deduplicates by content', async () => {
		const storage = await backend.group();
		const path = join(backend.root, 'db.zip');
		writeFileSync(path, pattern(200));
		const request = { name: 'db.zip', mimeType: 'application/zip', totalSize: 0 };
		expect((await storage.files.uploadLocalFileDedup(path, request)).kind).toBe('uploaded');
		expect((await storage.files.uploadLocalFileDedup(path, request)).kind).toBe('alreadyExists');
		expect(backend.telegram.messages).toHaveLength(1);
	});
});

describe('restore safety', () => {
	it('checks every chunk first, 100 ids at a time', async () => {
		const storage = await backend.group();
		storage.db.insert({
			id: 'many',
			name: 'many.zip',
			sizeBytes: 120,
			mimeType: 'application/zip',
			tgMessageId: 1,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		for (let ord = 0; ord < 120; ord++) {
			const tgMessageId = backend.telegram.addDocument(`part${ord}`, Buffer.from([ord]));
			storage.db.insertPart('many', { ord, tgMessageId, sizeBytes: 1, checksumSha256: null });
		}
		expect([...(await restore(storage, 'many'))]).toEqual([...Array(120).keys()]);
		const sizes = backend.telegram
			.requests('channels.getMessages')
			.map((request) => request.id.length);
		expect(sizes.slice(0, 2)).toEqual([100, 20]);
		expect(sizes.slice(2).every((size) => size === 1)).toBe(true);
	});

	it('is a 404 when a message was deleted', async () => {
		const storage = await backend.group();
		const { id, tgMessageId } = await upload(storage, pattern(10));
		backend.telegram.remove(tgMessageId);
		await expect(storage.files.download(id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('errors instead of ending short', async () => {
		const storage = await backend.group();
		const tgMessageId = backend.telegram.addDocument('short.zip', pattern(5));
		storage.db.insert({
			id: 'short',
			name: 'short.zip',
			sizeBytes: 10,
			mimeType: 'application/zip',
			tgMessageId,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		storage.db.insertPart('short', { ord: 0, tgMessageId, sizeBytes: 10, checksumSha256: null });
		await expect(restore(storage, 'short')).rejects.toThrow('fewer than expected');
	});

	it('follows FILE_MIGRATE', async () => {
		const storage = await backend.group();
		const bytes = pattern(50);
		const { id } = await upload(storage, bytes);
		backend.telegram.intercept = (request, options) => {
			if (request._ === 'upload.getFile' && options.dcId !== 5)
				throw InvocationError.rpc(303, 'FILE_MIGRATE_5');
		};
		expectSameBytes(await restore(storage, id), bytes);
	});

	it('catches a checksum mismatch', async () => {
		const storage = await backend.group();
		const { id } = await upload(storage, pattern(10));
		storage.db.setChecksum(id, 'wrong');
		await expect(storage.files.verify(id)).rejects.toMatchObject({ code: 'checksum_mismatch' });
	});

	it('restores into a directory', async () => {
		const storage = await backend.group();
		const bytes = pattern(1000);
		const { id } = await upload(storage, bytes);
		const target = await storage.files.downloadToDir(id, join(backend.root, 'restored'));
		expectSameBytes(readFileSync(target), bytes);
	});

	it("won't write outside that directory", async () => {
		const storage = await backend.group();
		storage.db.insert({
			id: 'evil',
			name: '../evil.zip',
			sizeBytes: 0,
			mimeType: 'application/zip',
			tgMessageId: 1,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		await expect(storage.files.downloadToDir('evil', backend.root)).rejects.toMatchObject({
			code: 'bad_request'
		});
	});
});

describe('rebuilding the index', () => {
	it('finds backups from another machine', async () => {
		const first = await backend.group();
		const bytes = pattern(1234);
		await upload(first, bytes, { text: 'note', metadata: { k: 'v' } });

		const second = await otherMachine();
		expect(await reconcileIndex(second)).toBe(1);
		const [row] = second.db.list();
		expect(row).toMatchObject({ text: 'note', metadata: '{"k":"v"}', checksumSha256: null });
		expectSameBytes(await restore(second, row.id), bytes);
	});

	it('fuses chunks tagged by different attempts', async () => {
		backend.telegram.addDocument('p2', pattern(4), { caption: chunkCaption(1, 2, 10) });
		backend.telegram.addDocument('p1', pattern(6), { caption: chunkCaption(0, 2, 10) });
		const storage = await backend.group();
		expect(await reconcileIndex(storage)).toBe(1);
		expect(storage.db.list()[0].sizeBytes).toBe(10);
	});

	it('accumulates across walks, then clears staging', async () => {
		const storage = await backend.group();
		const first = backend.telegram.addDocument('p1', pattern(6), {
			caption: chunkCaption(0, 2, 10)
		});
		expect(await walkAndMint(storage, { kind: 'all' })).toEqual([]);
		expect(storage.db.loadPendingChunks()).toHaveLength(1);

		backend.telegram.remove(first);
		backend.telegram.addDocument('p2', pattern(4), { caption: chunkCaption(1, 2, 10) });
		expect(await walkAndMint(storage, { kind: 'all' })).toHaveLength(1);
		expect(storage.db.loadPendingChunks()).toEqual([]);
	});

	it('keeps a healthy row', async () => {
		const storage = await backend.group();
		const { id } = await upload(storage, pattern(10));
		expect(await walkAndMint(storage, { kind: 'all' })).toEqual([]);
		expect(storage.db.list().map((row) => row.id)).toEqual([id]);
	});

	it('adopts unmarked zips only', async () => {
		backend.telegram.addDocument('manual.zip', pattern(3));
		backend.telegram.addDocument('photo.jpg', pattern(3), { mimeType: 'image/jpeg' });
		backend.telegram.addText('hello');
		const storage = await backend.group();
		expect(await reconcileIndex(storage)).toBe(1);
		expect(storage.db.list()[0].name).toBe('manual.zip');
		expect(await walkAndMint(storage, { kind: 'all' })).toEqual([]);
	});

	it('pages through a long history', async () => {
		backend.telegram.addDocument('oldest.zip', pattern(3));
		for (let i = 0; i < 350; i++) backend.telegram.addText();
		const storage = await backend.group();
		expect(await reconcileIndex(storage)).toBe(1);
		expect(backend.telegram.count('messages.getHistory')).toBeGreaterThanOrEqual(4);
	});

	it('walks once per connection, again after a restart', async () => {
		const storage = await backend.signedIn();
		const group = await storage.groups.resolve(null);
		await reconcileIndex(group);
		await reconcileIndex(group);
		expect(backend.telegram.count('messages.getHistory')).toBe(1);
		await storage.close();
		await reconcileIndex(await backend.group());
		expect(backend.telegram.count('messages.getHistory')).toBe(2);
	});

	it('filters the targeted walks', async () => {
		backend.telegram.addDocument('p', pattern(4), {
			caption: chunkCaption(0, 1, 4, { pipelineId: 'p', role: 'media' })
		});
		const storage = await backend.group();
		expect(await walkAndMint(storage, { kind: 'metadata' })).toEqual([]);
		expect(await walkAndMint(storage, { kind: 'pipeline', id: 'q' })).toEqual([]);
		expect(await walkAndMint(storage, { kind: 'pipeline', id: 'p' })).toHaveLength(1);
	});
});

describe('deleting', () => {
	it('removes messages, rows and staging', async () => {
		const storage = await backend.group();
		const { id } = await upload(storage, pattern(10));
		const { name } = storage.db.get(id)!;
		storage.db.upsertPendingPart({
			groupId: 'g',
			ord: 0,
			tgMessageId: 1,
			sizeBytes: 10,
			partChecksum: null,
			total: 1,
			name,
			declaredSize: 10,
			mime: 'application/zip',
			caption: null,
			checksum: null,
			metadata: null
		});

		await storage.files.delete(id);
		expect(backend.telegram.messages).toEqual([]);
		expect(storage.db.list()).toEqual([]);
		expect(storage.db.loadPendingChunks()).toEqual([]);
		await storage.files.deleteIfExists(id);
	});

	it('wipes the group in batches of 100', async () => {
		for (let i = 0; i < 250; i++) backend.telegram.addText();
		const storage = await backend.group();
		expect(await storage.files.deleteAll()).toBe(250);
		expect(backend.telegram.messages).toEqual([]);
		expect(backend.telegram.requests('channels.deleteMessages').map((r) => r.id.length)).toEqual([
			100, 100, 50
		]);
	});

	it('works in a basic group', async () => {
		backend.telegram.basicGroup = true;
		const storage = await backend.group();
		const bytes = pattern(10);
		const { id } = await upload(storage, bytes);
		expectSameBytes(await restore(storage, id), bytes);
		await storage.files.delete(id);
		expect(backend.telegram.count('messages.deleteMessages')).toBe(1);
	});

	it('fails clearly for what is not there', async () => {
		const storage = await backend.group();
		await expect(storage.files.delete('missing')).rejects.toMatchObject({ code: 'not_found' });
		await expect(storage.files.download('missing')).rejects.toMatchObject({ code: 'not_found' });
		await expect(storage.files.verify('missing')).rejects.toMatchObject({ code: 'not_found' });
		expect(storage.db.list()).toEqual([]);
	});

	it('fails clearly without a client', async () => {
		const storage = await backend.open();
		await expect(storage.groups.resolve(null)).rejects.toMatchObject({
			code: 'credentials_missing'
		});
	});
});
