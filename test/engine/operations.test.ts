// @vitest-environment node
// What each CLI command asks of the engine, without the terminal around it.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGroup } from '../../src/cli/context';
import { listFiles, uploadedEntry } from '../../src/lib/telegram/catalog';
import { InvocationError } from '../../src/lib/telegram/invocation-error';
import { fileNameOf, startUpload } from '../../src/lib/telegram/local-paths';
import { groupsDir, sessionPath, telegramDir } from '../../src/lib/telegram/paths';
import { restoreToFile } from '../../src/lib/telegram/restore';
import { readStatus } from '../../src/lib/telegram/status';
import type { TelegramStorage } from '../../src/lib/telegram/storage';
import { parseTransfer } from '../../src/lib/telegram/transfer';
import { isInsideAppData } from '../../src/lib/telegram/upload-paths';
import { parseJson } from '../../src/utils/json/losslessJson';
import { CHANNEL_ID, USER_ID } from './support/fake-telegram';
import { settledUpload, useBackend } from './support/harness';

const backend = useBackend();

let out: string;

beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), 'tgb-out-'));
});

afterEach(() => {
	rmSync(out, { recursive: true, force: true });
});

async function rejectsWith(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ code });
}

/** Back up a zip by path, as `tgb upload` does, and return its listing. */
async function uploaded(
	storage: TelegramStorage,
	content: string = '0123456789',
	name = 'db.zip',
	extra: { text?: string; metadata?: unknown; name?: string } = {}
) {
	const group = await storage.groups.resolve(null);
	const path = join(backend.root, name);
	writeFileSync(path, content);
	const [started] = await startUpload(storage, group, { path, ...extra });
	const done = await settledUpload(storage, started.uploadId);
	expect(done).toMatchObject({ status: 'completed', error: null });
	return uploadedEntry(group, done.fileId!);
}

describe('without credentials', () => {
	it('boots without creating an index', async () => {
		const storage = await backend.open();
		expect(existsSync(groupsDir(backend.root))).toBe(false);
		expect(storage.uploads.list()).toEqual([]);
		expect(storage.current).toBeNull();
	});

	it('reports an uninitialised status', async () => {
		expect(await readStatus(await backend.open())).toEqual({
			hasCredentials: false,
			connected: false,
			signedIn: false,
			authorized: false,
			loginInProgress: null,
			codeDelivery: null,
			user: null,
			groups: [],
			activeGroupId: null
		});
	});

	it.each([
		['login', (storage: TelegramStorage) => storage.login.start('+12025550100')],
		['qr login', (storage: TelegramStorage) => storage.login.qrStep()],
		['transfer export', (storage: TelegramStorage) => storage.exportTransfer('full')],
		['the chosen group', (storage: TelegramStorage) => resolveGroup(storage)],
		['a named group', (storage: TelegramStorage) => resolveGroup(storage, 'TGB-main')],
		['available groups', (storage: TelegramStorage) => storage.groups.available()],
		['group creation', (storage: TelegramStorage) => storage.groups.create('x')]
	])('%s needs credentials', async (_name, action) => {
		await rejectsWith(action(await backend.open()), 'credentials_missing');
	});

	it.each([
		['code', (storage: TelegramStorage) => storage.login.submitCode('12345')],
		['password', (storage: TelegramStorage) => storage.login.submitPassword('p')],
		['resend', (storage: TelegramStorage) => storage.login.resend()],
		['restart', (storage: TelegramStorage) => storage.restartLogin()]
	])('%s has no login in progress', async (_name, action) => {
		await rejectsWith(action(await backend.open()), 'no_login_in_progress');
	});

	it('logs out and clears credentials idempotently', async () => {
		const storage = await backend.open();
		await storage.logout();
		await storage.deleteCredentials();
		expect(storage.credentials).toBeNull();
	});

	it('knows no uploads', async () => {
		const storage = await backend.open();
		expect(storage.uploads.list()).toEqual([]);
		expect(storage.uploads.get('no')).toBeNull();
		expect(storage.uploads.cancel('no')).toBe(false);
		expect(storage.uploads.pause('no')).toBe(false);
		expect(storage.uploads.resume('no')).toBe(false);
	});
});

describe('credentials and transfer', () => {
	it('saves credentials and connects', async () => {
		const storage = await backend.open();
		await storage.setCredentials({ apiId: 777, apiHash: 'abc' });
		expect(storage.credentials).toEqual({ apiId: 777, apiHash: 'abc' });
		expect(storage.current).not.toBeNull();
	});

	it.each([
		{ apiId: 0, apiHash: 'abc' },
		{ apiId: 1, apiHash: '   ' }
	])('rejects %j', async (credentials) => {
		await rejectsWith((await backend.open()).setCredentials(credentials), 'bad_request');
	});

	it.each([
		'{"credentials":{"apiId":"1","apiHash":"abc"}}',
		'{"credentials":{"apiId":1}}',
		'{"v":-1}',
		'[]'
	])('refuses the transfer file %s', (text) => {
		expect(() => parseTransfer(text)).toThrow(expect.objectContaining({ code: 'bad_request' }));
	});

	it("doesn't echo a malformed transfer file", () => {
		expect(() => parseTransfer('{"session":"hunter2" oops')).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
		);
	});

	it.each([
		{ kind: 'something-else' },
		{ v: 7, credentials: { apiId: 1, apiHash: 'x' } },
		{},
		{ credentials: { apiId: 0, apiHash: '' } }
	])('rejects the transfer %j', async (json) => {
		const storage = await backend.open();
		await rejectsWith(storage.importTransfer(parseTransfer(JSON.stringify(json))), 'bad_request');
	});

	it('rejects an unknown scope', async () => {
		await rejectsWith((await backend.open()).exportTransfer('wrong'), 'bad_request');
	});

	it('keeps the session when a transfer is invalid', async () => {
		const storage = await backend.signedIn();
		const before = storage.current;
		const text = JSON.stringify({ credentials: { apiId: 0, apiHash: '' }, session: {} });
		await rejectsWith(storage.importTransfer(parseTransfer(text)), 'bad_request');
		expect(storage.current).toBe(before);
		expect(existsSync(sessionPath(backend.root))).toBe(false);
	});

	it('moves a session between machines exactly', async () => {
		const first = await backend.signedIn();
		const { accessHash } = backend.telegram.user;
		first.current!.session.setSelf({ id: USER_ID, accessHash: accessHash!, bot: false });

		const payload = JSON.stringify(await first.exportTransfer('full'));
		expect(payload).toContain(`"auth":${accessHash}`);

		const second = await backend.open(join(backend.root, 'second'));
		await second.importTransfer(parseTransfer(payload));
		expect(JSON.stringify(await second.exportTransfer('full'))).toBe(payload);
		expect((await second.exportTransfer('credentials')).session).toBeUndefined();
	});

	it('closes the client it replaces', async () => {
		const storage = await backend.signedIn();
		await storage.setCredentials({ apiId: 9, apiHash: 'next' });
		expect(backend.telegram.transports.map((transport) => transport.closed)).toEqual([true, false]);
	});
});

describe('login', () => {
	it('signs in by code, keeping it through a typo', async () => {
		backend.telegram.authorized = false;
		const storage = await backend.signedIn();
		expect(await storage.login.start('+12025550100')).toMatchObject({
			method: 'app',
			nextMethod: 'sms'
		});
		expect(await readStatus(storage)).toMatchObject({
			loginInProgress: 'awaiting_code',
			codeDelivery: { method: 'app' }
		});

		await rejectsWith(storage.login.submitCode('00000'), 'invalid_code');
		expect(await storage.login.submitCode('12345')).toMatchObject({
			outcome: 'authenticated',
			user: { id: USER_ID, lastName: null }
		});
		expect(storage.current!.session.updatesState.pts).toBe(10);
		expect((await storage.login.progress()).stage).toBeNull();
	});

	it('uses the new hash after a resend', async () => {
		const storage = await backend.signedIn();
		await storage.login.start('+12025550100');
		await storage.login.resend();
		await storage.login.submitCode('12345');
		expect(backend.telegram.requests('auth.signIn')[0].phoneCodeHash).toBe('hash-2');
	});

	it('follows PHONE_MIGRATE', async () => {
		backend.telegram.premigrateDc = 4;
		const storage = await backend.signedIn();
		await storage.login.start('+1');
		expect(storage.current!.session.homeDcId).toBe(4);
		expect(backend.telegram.count('auth.sendCode')).toBe(2);
	});

	it('finishes 2FA with the password', async () => {
		backend.telegram.passwordNeeded = true;
		const storage = await backend.signedIn();
		await storage.login.start('+1');
		expect(await storage.login.submitCode('12345')).toEqual({
			outcome: 'passwordRequired',
			hint: 'pet'
		});
		expect((await storage.login.progress()).stage).toBe('awaiting_password');
		expect((await storage.login.submitPassword('secret')).outcome).toBe('authenticated');
	});

	it('rejects a wrong password', async () => {
		backend.telegram.qr = 'password';
		const storage = await backend.signedIn();
		await storage.login.qrStep();
		await rejectsWith(storage.login.submitPassword('wrong'), 'invalid_password');
	});

	it('shows a QR as unpadded base64url', async () => {
		expect(await (await backend.signedIn()).login.qrStep()).toEqual({
			outcome: 'pending',
			url: 'tg://login?token=-_8',
			expiresAt: 99
		});
	});

	it.each(['success', 'migrate'] as const)('finishes a QR login (%s)', async (qr) => {
		backend.telegram.qr = qr;
		const storage = await backend.signedIn();
		expect((await storage.login.qrStep()).outcome).toBe('authenticated');
		expect(storage.current!.session.homeDcId).toBe(qr === 'migrate' ? 4 : 2);
	});

	it('logs out, wipes and stays ready for a login', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		storage.current!.session.setHomeDc(2);
		const { db } = await storage.groups.resolve(null);
		expect(existsSync(sessionPath(backend.root))).toBe(true);
		await storage.logout();
		expect(existsSync(sessionPath(backend.root))).toBe(false);
		expect(storage.current).not.toBeNull();
		expect(db.list()).toEqual([]);
		expect(backend.telegram.messages).toHaveLength(1);
	});
});

describe('signed out remotely', () => {
	it('asks for a login', async () => {
		backend.telegram.authorized = false;
		await rejectsWith(resolveGroup(await backend.signedIn()), 'not_authenticated');
	});
});

describe('uploads and restores', () => {
	it('uploads, lists, restores and deletes', async () => {
		const storage = await backend.signedIn();
		const entry = await uploaded(storage);
		expect(entry).toMatchObject({ name: 'db.zip', sizeBytes: 10, complete: true });
		const group = await storage.groups.resolve(null);
		expect(await listFiles(group)).toEqual([entry]);

		const path = await restoreToFile(group, entry.id, { target: out });
		expect(path).toBe(join(out, 'db.zip'));
		expect(readFileSync(path, 'utf8')).toBe('0123456789');

		await group.files.delete(entry.id);
		await rejectsWith(restoreToFile(group, entry.id, { target: out }), 'not_found');
	});

	it('restores to a file path, and only overwrites when told to', async () => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage);
		const group = await storage.groups.resolve(null);
		const target = join(out, 'copy.zip');
		const progress: number[] = [];
		await restoreToFile(group, id, { target, onProgress: (written) => progress.push(written) });
		expect(readFileSync(target, 'utf8')).toBe('0123456789');
		expect(progress.at(-1)).toBe(10);

		await rejectsWith(restoreToFile(group, id, { target }), 'bad_request');
		writeFileSync(target, 'old');
		await restoreToFile(group, id, { target, overwrite: true });
		expect(readFileSync(target, 'utf8')).toBe('0123456789');
	});

	it('leaves nothing behind when a restore fails', async () => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage);
		const group = await storage.groups.resolve(null);
		backend.telegram.intercept = (request) => {
			if (request._ === 'upload.getFile') throw InvocationError.rpc(400, 'LOCATION_INVALID');
		};
		await expect(restoreToFile(group, id, { target: out })).rejects.toThrow();
		expect(readdirSync(out)).toEqual([]);
	});

	it('takes text and lossless metadata', async () => {
		const storage = await backend.signedIn();
		const entry = await uploaded(storage, 'x', 'db.zip', {
			text: 'note',
			metadata: parseJson('{"n":8123456789012345678}')
		});
		const listed = JSON.stringify(entry);
		expect(listed).toContain('"metadata":{"n":8123456789012345678}');
		expect(listed).toContain('"text":"note"');
	});

	it('handles names outside Latin-1', async () => {
		const storage = await backend.signedIn();
		const entry = await uploaded(storage, 'zip bytes', '备份.zip');
		expect(entry.name).toBe('备份.zip');
		const path = await restoreToFile(await storage.groups.resolve(null), entry.id, { target: out });
		expect(path).toBe(join(out, '备份.zip'));
		expect(readFileSync(path, 'utf8')).toBe('zip bytes');
	});

	it('guesses the type from the name', async () => {
		const storage = await backend.signedIn();
		expect(await uploaded(storage, 'abc')).toMatchObject({
			mimeType: 'application/zip',
			sizeBytes: 3
		});
	});

	it('refuses what is not a zip', async () => {
		const storage = await backend.signedIn();
		const group = await storage.groups.resolve(null);
		const path = join(backend.root, 'cover.jpg');
		writeFileSync(path, 'x');
		await rejectsWith(startUpload(storage, group, { path }), 'unsupported_media_type');
		expect(backend.telegram.messages).toEqual([]);
	});

	it.each([
		[2, 4, '234'],
		[7, 9, '789'],
		[8, 20, '89']
	])('reads bytes %i to %i', async (start, end, text) => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage);
		const group = await storage.groups.resolve(null);
		const chunks: Buffer[] = [];
		for await (const chunk of await group.files.downloadRange(id, start, end)) {
			chunks.push(Buffer.from(chunk));
		}
		expect(Buffer.concat(chunks).toString()).toBe(text);
	});

	it('restores an empty zip', async () => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage, '');
		const path = await restoreToFile(await storage.groups.resolve(null), id, { target: out });
		expect(readFileSync(path, 'utf8')).toBe('');
	});

	it('refuses an incomplete backup', async () => {
		const storage = await backend.signedIn();
		const group = await storage.groups.resolve(null);
		group.db.insert({
			id: 'half',
			name: 'half.zip',
			sizeBytes: 10,
			mimeType: 'application/zip',
			tgMessageId: 1,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		await rejectsWith(restoreToFile(group, 'half', { target: out }), 'backup_incomplete');
		expect(readdirSync(out)).toEqual([]);
	});

	it('lists the index when the walk fails', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		backend.telegram.intercept = (request) => {
			if (request._ === 'messages.getHistory') throw InvocationError.rpc(500, 'INTERNAL');
		};
		expect(await listFiles(await storage.groups.resolve(null))).toHaveLength(1);
	});

	it('wipes everything on delete-all', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		const group = await resolveGroup(storage, `channel-${CHANNEL_ID}`);
		expect(await group.files.deleteAll()).toBe(1);
	});
});

describe('uploads by path', () => {
	it('stores a zip under another name', async () => {
		const storage = await backend.signedIn();
		expect(await uploaded(storage, 'abc', 'db.zip', { name: 'renamed.zip' })).toMatchObject({
			name: 'renamed.zip',
			sizeBytes: 3,
			complete: true
		});
	});

	it('takes a zip from anywhere on the machine', async () => {
		const storage = await backend.signedIn();
		const path = join(out, 'elsewhere.zip');
		writeFileSync(path, 'abc');
		const [started] = await startUpload(storage, await storage.groups.resolve(null), { path });
		expect(await settledUpload(storage, started.uploadId)).toMatchObject({ status: 'completed' });
	});

	it('uploads in the background', async () => {
		const storage = await backend.signedIn();
		const path = join(backend.root, 'db.zip');
		writeFileSync(path, 'abc');
		const group = await storage.groups.resolve(null);
		const [started] = await startUpload(storage, group, { path, refId: 'mine' });
		expect(started).toMatchObject({ refId: 'mine', status: 'running', transferStartedAt: null });
		expect(await settledUpload(storage, started.uploadId)).toMatchObject({
			status: 'completed',
			bytesUploaded: 3,
			chunksCompleted: 1
		});
	});

	it('queues every zip in a folder, in order', async () => {
		const storage = await backend.signedIn();
		const folder = join(backend.root, 'zips');
		mkdirSync(join(folder, 'a'), { recursive: true });
		mkdirSync(join(folder, 'a-b'));
		writeFileSync(join(folder, 'a', 'z.zip'), '1');
		writeFileSync(join(folder, 'a-b', 'x.zip'), '2');
		writeFileSync(join(folder, 'readme.txt'), 'not a backup');

		const started = await startUpload(storage, await storage.groups.resolve(null), {
			path: folder
		});
		expect(started.map((upload) => [upload.name, upload.refId])).toEqual([
			['z.zip', 'zips'],
			['x.zip', 'zips']
		]);
		await vi.waitFor(() =>
			expect(storage.uploads.list().map((upload) => [upload.name, upload.status])).toEqual([
				['z.zip', 'completed'],
				['x.zip', 'completed']
			])
		);
	});

	it('handles folder names that are not UTF-8', async () => {
		const storage = await backend.signedIn();
		const folder = join(backend.root, 'odd');
		mkdirSync(folder);
		const inner = Buffer.concat([Buffer.from(`${folder}/`), Buffer.from([0xff, 0xfe])]);
		mkdirSync(inner);
		writeFileSync(Buffer.concat([inner, Buffer.from('/ok.zip')]), 'abc');
		await startUpload(storage, await storage.groups.resolve(null), { path: folder });
		await vi.waitFor(() =>
			expect(storage.uploads.list()[0]).toMatchObject({ name: 'ok.zip', status: 'completed' })
		);
	});

	it.each([
		['', 'bad_request'],
		['relative.zip', 'bad_request'],
		['/etc/passwd', 'unsupported_media_type']
	])('rejects "%s"', async (path, code) => {
		const storage = await backend.signedIn();
		await rejectsWith(startUpload(storage, await storage.groups.resolve(null), { path }), code);
	});

	it('knows what is the app’s own data', async () => {
		writeFileSync(join(backend.root, 'file.zip'), 'x');
		mkdirSync(telegramDir(backend.root), { recursive: true });
		expect(await isInsideAppData(join(backend.root, 'file.zip'), backend.root)).toBe(false);
		expect(await isInsideAppData(backend.root, backend.root)).toBe(false);
		expect(await isInsideAppData(telegramDir(backend.root), backend.root)).toBe(true);
		expect(await isInsideAppData(sessionPath(backend.root), backend.root)).toBe(true);
		expect(fileNameOf('/a/b.zip/')).toBe('b.zip');
		expect(fileNameOf('/a/..')).toBeNull();
	});
});
