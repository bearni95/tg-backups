// @vitest-environment node
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUpload } from '../../src/lib/telegram/local-paths';
import { sessionPath, telegramDir } from '../../src/lib/telegram/paths';
import type { TelegramStorage } from '../../src/lib/telegram/storage';
import { useBackend } from './support/harness';

const backend = useBackend();

let outside: string;
let folder: string;

beforeEach(() => {
	outside = mkdtempSync(join(tmpdir(), 'tgb-outside-'));
	writeFileSync(join(outside, 'secret.zip'), 'SECRET');
	folder = join(backend.root, 'zips');
	mkdirSync(folder);
});

afterEach(() => {
	rmSync(outside, { recursive: true, force: true });
});

async function queue(storage: TelegramStorage, path: string, name?: string) {
	return startUpload(storage, await storage.groups.resolve(null), { path, name });
}

async function settled(storage: TelegramStorage) {
	await vi.waitFor(() =>
		expect(storage.uploads.list().every((upload) => upload.finishedAt !== null)).toBe(true)
	);
	return storage.uploads.list();
}

async function queuedNames(storage: TelegramStorage) {
	return (await settled(storage)).map((upload) => upload.name).sort();
}

describe('folder backups stay inside the folder', () => {
	it('skips a linked file outside it', async () => {
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(join(outside, 'secret.zip'), join(folder, 'secret.zip'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('skips a linked folder outside it', async () => {
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(outside, join(folder, 'linked'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('skips a chain of links leading out', async () => {
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(outside, join(backend.root, 'hop'));
		symlinkSync(join(backend.root, 'hop'), join(folder, 'linked'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('is not fooled by a sibling with the same prefix', async () => {
		const sibling = `${folder}-sibling`;
		mkdirSync(sibling);
		writeFileSync(join(sibling, 'secret.zip'), 'SECRET');
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(sibling, join(folder, 'linked'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('still follows links that stay inside', async () => {
		const other = join(folder, 'other');
		mkdirSync(other);
		writeFileSync(join(other, 'linked.zip'), 'inside');
		symlinkSync(join(other, 'linked.zip'), join(folder, 'link.zip'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['link.zip', 'linked.zip']);
	});

	it('survives loops and broken links', async () => {
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(folder, join(folder, 'loop'));
		symlinkSync(join(folder, 'missing'), join(folder, 'broken.zip'));
		symlinkSync(join(folder, 'self.zip'), join(folder, 'self.zip'));
		const storage = await backend.signedIn();
		expect(await queue(storage, folder)).toHaveLength(1);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('refuses a folder with nothing but links out', async () => {
		symlinkSync(outside, join(folder, 'linked'));
		const storage = await backend.signedIn();
		await expect(queue(storage, folder)).rejects.toMatchObject({ code: 'bad_request' });
		expect(storage.uploads.list()).toEqual([]);
	});

	it('works when the folder is itself a link', async () => {
		const linked = join(backend.root, 'linked-zips');
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(folder, linked);
		const storage = await backend.signedIn();
		await queue(storage, linked);
		expect(await settled(storage)).toMatchObject([{ name: 'mine.zip', status: 'completed' }]);
	});

	it('works when the data folder is itself a link', async () => {
		const real = join(backend.root, 'real-root');
		mkdirSync(join(real, 'zips'), { recursive: true });
		writeFileSync(join(real, 'zips', 'mine.zip'), 'mine');
		const linkedRoot = join(backend.root, 'linked-root');
		symlinkSync(real, linkedRoot);
		const storage = await backend.signedIn(linkedRoot);
		await queue(storage, join(linkedRoot, 'zips'));
		expect(await settled(storage)).toMatchObject([{ name: 'mine.zip', status: 'completed' }]);
	});

	it('follows a link the user names directly', async () => {
		symlinkSync(join(outside, 'secret.zip'), join(folder, 'named.zip'));
		const storage = await backend.signedIn();
		await queue(storage, join(folder, 'named.zip'));
		expect(await settled(storage)).toMatchObject([{ name: 'named.zip', status: 'completed' }]);
	});
});

describe('a queued upload is checked again when it opens', () => {
	async function holdUploads() {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		backend.telegram.intercept = async (request) => {
			if (request._ === 'upload.saveFilePart') await held;
		};
		return () => release();
	}

	it('refuses a file in a folder swapped for a link out of it while queued', async () => {
		const storage = await backend.signedIn();
		const release = await holdUploads();
		writeFileSync(join(backend.root, 'first.zip'), 'first');
		writeFileSync(join(folder, 'secret.zip'), 'harmless');
		await queue(storage, join(backend.root, 'first.zip'));
		await queue(storage, folder);

		renameSync(join(folder, 'secret.zip'), join(folder, 'moved'));
		symlinkSync(join(outside, 'secret.zip'), join(folder, 'secret.zip'));
		release();

		const uploads = await settled(storage);
		expect(uploads.find((upload) => upload.name === 'secret.zip')).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('not an uploadable file')
		});
		expect(backend.telegram.messages).toHaveLength(1);
	});

	it('refuses a file swapped for a link to the session while queued', async () => {
		const storage = await backend.signedIn();
		writeFileSync(sessionPath(backend.root), '{}');
		const release = await holdUploads();
		writeFileSync(join(backend.root, 'first.zip'), 'first');
		writeFileSync(join(outside, 'next.zip'), 'harmless');
		await queue(storage, join(backend.root, 'first.zip'));
		await queue(storage, join(outside, 'next.zip'));

		rmSync(join(outside, 'next.zip'));
		symlinkSync(sessionPath(backend.root), join(outside, 'next.zip'));
		release();

		const uploads = await settled(storage);
		expect(uploads.find((upload) => upload.name === 'next.zip')).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('not an uploadable file')
		});
		expect(backend.telegram.messages).toHaveLength(1);
	});
});

describe('the app’s own state is never a backup', () => {
	it('skips a link to the session', async () => {
		const storage = await backend.signedIn();
		writeFileSync(sessionPath(backend.root), '{}');
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(sessionPath(backend.root), join(folder, 'session.zip'));
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('skips it when backing up the whole data folder', async () => {
		const storage = await backend.signedIn();
		writeFileSync(join(telegramDir(backend.root), 'hidden.zip'), 'state');
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		await queue(storage, backend.root);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('refuses it renamed', async () => {
		const storage = await backend.signedIn();
		const path = join(telegramDir(backend.root), 'credentials.json');
		await expect(queue(storage, path, 'innocent.zip')).rejects.toMatchObject({
			code: 'bad_request'
		});
		await expect(queue(storage, telegramDir(backend.root))).rejects.toMatchObject({
			code: 'bad_request'
		});
		expect(backend.telegram.messages).toEqual([]);
	});

	it('refuses a link to it', async () => {
		const storage = await backend.signedIn();
		writeFileSync(sessionPath(backend.root), '{}');
		symlinkSync(sessionPath(backend.root), join(outside, 'session.zip'));
		await expect(queue(storage, join(outside, 'session.zip'))).rejects.toMatchObject({
			code: 'bad_request'
		});
	});
});
