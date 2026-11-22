// @vitest-environment node
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramStorage } from '../../src/lib/server/telegram/storage';
import { call, useBackend } from './support/harness';

const backend = useBackend();
const API = '/api/telegram';

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

function queue(storage: TelegramStorage, path: string) {
	return call(storage, 'POST', `${API}/uploads`, { json: { path } });
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

describe('folder backups stay inside the data folder', () => {
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
		const sibling = `${backend.root}-sibling`;
		mkdirSync(sibling);
		try {
			writeFileSync(join(sibling, 'secret.zip'), 'SECRET');
			writeFileSync(join(folder, 'mine.zip'), 'mine');
			symlinkSync(sibling, join(folder, 'linked'));
			const storage = await backend.signedIn();
			await queue(storage, folder);
			expect(await queuedNames(storage)).toEqual(['mine.zip']);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it('still follows links that stay inside', async () => {
		const other = join(backend.root, 'other');
		mkdirSync(other);
		writeFileSync(join(other, 'linked.zip'), 'inside');
		symlinkSync(other, join(folder, 'link'));
		const storage = await backend.signedIn();
		await queue(storage, folder);
		expect(await settled(storage)).toMatchObject([{ name: 'linked.zip', status: 'completed' }]);
	});

	it('survives loops and broken links', async () => {
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(folder, join(folder, 'loop'));
		symlinkSync(join(folder, 'missing'), join(folder, 'broken.zip'));
		symlinkSync(join(folder, 'self.zip'), join(folder, 'self.zip'));
		const storage = await backend.signedIn();
		expect((await queue(storage, folder)).status).toBe(200);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it('refuses a folder with nothing but links out', async () => {
		symlinkSync(outside, join(folder, 'linked'));
		const storage = await backend.signedIn();
		expect((await queue(storage, folder)).status).toBe(400);
		expect(storage.uploads.list()).toEqual([]);
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
});

describe('a queued upload is checked again when it opens', () => {
	for (const swapped of ['file', 'folder'] as const) {
		it(`refuses a ${swapped} swapped for a link out while queued`, async () => {
			const storage = await backend.signedIn();
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			backend.telegram.intercept = async (request) => {
				if (request._ === 'upload.saveFilePart') await held;
			};
			writeFileSync(join(backend.root, 'first.zip'), 'first');
			writeFileSync(join(folder, 'secret.zip'), 'harmless');
			await queue(storage, join(backend.root, 'first.zip'));
			await queue(storage, join(folder, 'secret.zip'));

			if (swapped === 'file') {
				renameSync(join(folder, 'secret.zip'), join(folder, 'moved'));
				symlinkSync(join(outside, 'secret.zip'), join(folder, 'secret.zip'));
			} else {
				renameSync(folder, `${folder}-moved`);
				symlinkSync(outside, folder);
			}
			release();

			const uploads = await settled(storage);
			expect(uploads.find((upload) => upload.name === 'secret.zip')).toMatchObject({
				status: 'failed',
				error: expect.stringContaining('data root')
			});
			expect(backend.telegram.messages).toHaveLength(1);
		});
	}
});

describe('the app’s own state is never a backup', () => {
	it('skips a link to the session', async () => {
		const storage = await backend.signedIn();
		writeFileSync(join(backend.root, 'telegram', 'session.sqlite'), '{}');
		writeFileSync(join(folder, 'mine.zip'), 'mine');
		symlinkSync(join(backend.root, 'telegram', 'session.sqlite'), join(folder, 'session.zip'));
		await queue(storage, folder);
		expect(await queuedNames(storage)).toEqual(['mine.zip']);
	});

	it.each(['uploads', 'files/from-path'])('refuses it renamed, via %s', async (route) => {
		const storage = await backend.signedIn();
		const path = join(backend.root, 'telegram', 'credentials.json');
		const json = { path, name: 'innocent.zip', mimeType: 'application/zip' };
		expect((await call(storage, 'POST', `${API}/${route}`, { json })).status).toBe(400);
		expect(backend.telegram.messages).toEqual([]);
	});
});
