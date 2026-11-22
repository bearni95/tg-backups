// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InvocationError } from '../../src/lib/server/telegram/invocation-error';
import { fileNameOf, isUnderDataRoot } from '../../src/lib/server/telegram/local-paths';
import { groupsDir, sessionPath, telegramDir } from '../../src/lib/server/telegram/paths';
import type { TelegramStorage } from '../../src/lib/server/telegram/storage';
import { CHANNEL_ID, USER_ID } from './support/fake-telegram';
import { call, useBackend } from './support/harness';

const backend = useBackend();
const API = '/api/telegram';

function form(
	name = 'db.zip',
	content: BlobPart = 'zip bytes',
	type = 'application/zip',
	extra: Record<string, string> = {}
) {
	const body = new FormData();
	body.append('name', name);
	body.append('size', '1');
	for (const [key, value] of Object.entries(extra)) body.append(key, value);
	body.append('file', new Blob([content], { type }), name);
	return body;
}

async function uploaded(storage: TelegramStorage, content: BlobPart = '0123456789') {
	const response = await call(storage, 'POST', `${API}/files`, { body: form('db.zip', content) });
	expect(response.status).toBe(200);
	return response.json();
}

async function expectError(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect((await response.json()).code).toBe(code);
}

describe('without credentials', () => {
	it('boots without creating an index', async () => {
		const storage = await backend.open();
		expect(existsSync(groupsDir(backend.root))).toBe(false);
		expect(storage.uploads.list()).toEqual([]);
		expect(storage.current).toBeNull();
	});

	it('reports an uninitialised status', async () => {
		const response = await call(await backend.open(), 'GET', `${API}/status`);
		expect(await response.json()).toEqual({
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
		['GET', '/credentials'],
		['POST', '/auth/start', { phone: '+12025550100' }],
		['POST', '/auth/qr'],
		['GET', '/transfer'],
		['GET', '/files'],
		['POST', '/files/delete-all'],
		['GET', '/files/some-id'],
		['DELETE', '/files/some-id'],
		['POST', '/files/load-media/p1'],
		['POST', '/files/from-path', { path: '/tmp/whatever' }],
		['POST', '/files/from-path', { path: '' }],
		['POST', '/uploads', { path: '/tmp/whatever' }]
	])('%s %s needs credentials', async (method, path, json?: unknown) => {
		const response = await call(await backend.open(), method, API + path, { json });
		await expectError(response, 400, 'credentials_missing');
	});

	it.each([
		['/auth/code', { code: '12345' }],
		['/auth/password', { password: 'p' }],
		['/auth/resend', undefined]
	])('%s has no login in progress', async (path, json) => {
		const response = await call(await backend.open(), 'POST', API + path, { json });
		await expectError(response, 400, 'no_login_in_progress');
	});

	it('logs out and clears credentials idempotently', async () => {
		const storage = await backend.open();
		expect((await call(storage, 'POST', `${API}/auth/logout`)).status).toBe(200);
		const cleared = await call(storage, 'DELETE', `${API}/credentials`);
		expect(await cleared.json()).toEqual({ ok: true });
	});

	it('lists no uploads', async () => {
		const response = await call(await backend.open(), 'GET', `${API}/uploads`);
		expect(await response.json()).toEqual({ uploads: [] });
	});

	it.each([
		['GET', '/uploads/no'],
		['DELETE', '/uploads/no'],
		['POST', '/uploads/no/pause'],
		['POST', '/uploads/no/resume']
	])('%s %s is not found', async (method, path) => {
		await expectError(await call(await backend.open(), method, API + path), 404, 'not_found');
	});

	it('answers health', async () => {
		const response = await call(await backend.open(), 'GET', '/api/health');
		expect(await response.json()).toMatchObject({ status: 'ok' });
	});
});

describe('credentials and transfer', () => {
	it('saves and returns credentials', async () => {
		const storage = await backend.open();
		const json = { apiId: 777, apiHash: 'abc' };
		expect(await (await call(storage, 'POST', `${API}/credentials`, { json })).json()).toEqual({
			ok: true
		});
		expect(await (await call(storage, 'GET', `${API}/credentials`)).json()).toEqual(json);
		expect(storage.current).not.toBeNull();
	});

	it.each([
		[{ apiId: 0, apiHash: 'abc' }, 400],
		[{ apiId: 1, apiHash: '   ' }, 400],
		[{ apiId: '1', apiHash: 'abc' }, 422],
		[{ apiId: 1 }, 422]
	])('rejects %j', async (json, status) => {
		expect((await call(await backend.open(), 'POST', `${API}/credentials`, { json })).status).toBe(
			status
		);
	});

	it('requires JSON, the CSRF defence', async () => {
		const response = await call(await backend.open(), 'POST', `${API}/credentials`, {
			body: '{"apiId":1,"apiHash":"x"}',
			headers: { 'content-type': 'text/plain' }
		});
		expect(response.status).toBe(415);
	});

	it("doesn't echo a malformed body", async () => {
		const response = await call(await backend.open(), 'POST', `${API}/auth/password`, {
			body: '{"password":"hunter2" oops',
			headers: { 'content-type': 'application/json' }
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain('hunter2');
	});

	it.each([
		{ kind: 'something-else' },
		{ v: 7, credentials: { apiId: 1, apiHash: 'x' } },
		{},
		{ credentials: { apiId: 0, apiHash: '' } }
	])('rejects the transfer %j', async (json) => {
		expect((await call(await backend.open(), 'POST', `${API}/transfer`, { json })).status).toBe(
			400
		);
	});

	it('rejects an unknown scope', async () => {
		expect((await call(await backend.open(), 'GET', `${API}/transfer?scope=wrong`)).status).toBe(
			400
		);
	});

	it('keeps the session when a transfer is invalid', async () => {
		const storage = await backend.signedIn();
		const before = storage.current;
		const json = { credentials: { apiId: 0, apiHash: '' }, session: {} };
		expect((await call(storage, 'POST', `${API}/transfer`, { json })).status).toBe(400);
		expect(storage.current).toBe(before);
		expect(existsSync(sessionPath(backend.root))).toBe(false);
	});

	it('moves a session between machines exactly', async () => {
		const first = await backend.signedIn();
		const { accessHash } = backend.telegram.user;
		first.current!.session.setSelf({ id: USER_ID, accessHash: accessHash!, bot: false });

		const payload = await (await call(first, 'GET', `${API}/transfer`)).text();
		expect(payload).toContain(`"auth":${accessHash}`);

		const second = await backend.open(join(backend.root, 'second'));
		const imported = await call(second, 'POST', `${API}/transfer`, {
			body: payload,
			headers: { 'content-type': 'application/json' }
		});
		expect(imported.status).toBe(200);
		expect(await (await call(second, 'GET', `${API}/transfer`)).text()).toBe(payload);

		const limited = await (await call(second, 'GET', `${API}/transfer?scope=credentials`)).json();
		expect(limited.session).toBeUndefined();
	});

	it('closes the client it replaces', async () => {
		const storage = await backend.signedIn();
		await call(storage, 'POST', `${API}/credentials`, { json: { apiId: 9, apiHash: 'next' } });
		expect(backend.telegram.transports.map((transport) => transport.closed)).toEqual([true, false]);
	});
});

describe('login', () => {
	it('signs in by code, keeping it through a typo', async () => {
		backend.telegram.authorized = false;
		const storage = await backend.signedIn();
		const started = await (
			await call(storage, 'POST', `${API}/auth/start`, { json: { phone: '+12025550100' } })
		).json();
		expect(started).toMatchObject({
			stage: 'awaiting_code',
			delivery: { method: 'app', nextMethod: 'sms' }
		});
		expect(await (await call(storage, 'GET', `${API}/status`)).json()).toMatchObject({
			loginInProgress: 'awaiting_code',
			codeDelivery: { method: 'app' }
		});

		await expectError(
			await call(storage, 'POST', `${API}/auth/code`, { json: { code: '00000' } }),
			400,
			'invalid_code'
		);
		const signedIn = await (
			await call(storage, 'POST', `${API}/auth/code`, { json: { code: '12345' } })
		).json();
		expect(signedIn).toMatchObject({
			outcome: 'authenticated',
			user: { id: USER_ID, lastName: null }
		});
		expect(storage.current!.session.updatesState.pts).toBe(10);
		expect((await storage.login.progress()).stage).toBeNull();
	});

	it('uses the new hash after a resend', async () => {
		const storage = await backend.signedIn();
		await call(storage, 'POST', `${API}/auth/start`, { json: { phone: '+12025550100' } });
		await call(storage, 'POST', `${API}/auth/resend`);
		await call(storage, 'POST', `${API}/auth/code`, { json: { code: '12345' } });
		expect(backend.telegram.requests('auth.signIn')[0].phoneCodeHash).toBe('hash-2');
	});

	it('follows PHONE_MIGRATE', async () => {
		backend.telegram.premigrateDc = 4;
		const storage = await backend.signedIn();
		expect(
			(await call(storage, 'POST', `${API}/auth/start`, { json: { phone: '+1' } })).status
		).toBe(200);
		expect(storage.current!.session.homeDcId).toBe(4);
		expect(backend.telegram.count('auth.sendCode')).toBe(2);
	});

	it('finishes 2FA with the password', async () => {
		backend.telegram.passwordNeeded = true;
		const storage = await backend.signedIn();
		await call(storage, 'POST', `${API}/auth/start`, { json: { phone: '+1' } });
		const step = await (
			await call(storage, 'POST', `${API}/auth/code`, { json: { code: '12345' } })
		).json();
		expect(step).toEqual({ outcome: 'passwordRequired', hint: 'pet' });
		expect((await storage.login.progress()).stage).toBe('awaiting_password');
		const done = await (
			await call(storage, 'POST', `${API}/auth/password`, { json: { password: 'secret' } })
		).json();
		expect(done.outcome).toBe('authenticated');
	});

	it('rejects a wrong password', async () => {
		backend.telegram.qr = 'password';
		const storage = await backend.signedIn();
		await call(storage, 'POST', `${API}/auth/qr`);
		await expectError(
			await call(storage, 'POST', `${API}/auth/password`, { json: { password: 'wrong' } }),
			400,
			'invalid_password'
		);
	});

	it('shows a QR as unpadded base64url', async () => {
		const response = await call(await backend.signedIn(), 'POST', `${API}/auth/qr`);
		expect(await response.json()).toEqual({
			outcome: 'pending',
			url: 'tg://login?token=-_8',
			expiresAt: 99
		});
	});

	it.each(['success', 'migrate'] as const)('finishes a QR login (%s)', async (qr) => {
		backend.telegram.qr = qr;
		const storage = await backend.signedIn();
		expect((await (await call(storage, 'POST', `${API}/auth/qr`)).json()).outcome).toBe(
			'authenticated'
		);
		expect(storage.current!.session.homeDcId).toBe(qr === 'migrate' ? 4 : 2);
	});

	it('logs out, wipes and stays ready for a login', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		storage.current!.session.setHomeDc(2);
		const { db } = await storage.groups.resolve(null);
		expect(existsSync(sessionPath(backend.root))).toBe(true);
		await call(storage, 'POST', `${API}/auth/logout`);
		expect(existsSync(sessionPath(backend.root))).toBe(false);
		expect(storage.current).not.toBeNull();
		expect(db.list()).toEqual([]);
		expect(backend.telegram.messages).toHaveLength(1);
	});
});

describe('signed out remotely', () => {
	it('returns 401', async () => {
		backend.telegram.authorized = false;
		await expectError(
			await call(await backend.signedIn(), 'GET', `${API}/files`),
			401,
			'not_authenticated'
		);
	});
});

describe('browser uploads and restores', () => {
	it('uploads, lists, restores and deletes', async () => {
		const storage = await backend.signedIn();
		const entry = await uploaded(storage);
		expect(entry).toMatchObject({ name: 'db.zip', sizeBytes: 10, complete: true });
		expect((await (await call(storage, 'GET', `${API}/files`)).json()).files).toEqual([entry]);

		const restored = await call(storage, 'GET', `${API}/files/${entry.id}`);
		expect(Object.fromEntries(restored.headers)).toMatchObject({
			'content-length': '10',
			'accept-ranges': 'bytes',
			'content-type': 'application/zip',
			'content-disposition': 'attachment; filename="db.zip"'
		});
		expect(await restored.text()).toBe('0123456789');

		expect(await (await call(storage, 'DELETE', `${API}/files/${entry.id}`)).json()).toEqual({
			ok: true
		});
		await expectError(await call(storage, 'GET', `${API}/files/${entry.id}`), 404, 'not_found');
	});

	it('leaves no staged file behind', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		expect(readdirSync(telegramDir(backend.root)).filter((name) => name.endsWith('.tmp'))).toEqual(
			[]
		);
	});

	it('takes text and lossless metadata', async () => {
		const storage = await backend.signedIn();
		const body = form('db.zip', 'x', 'application/zip', {
			text: 'note',
			metadata: '{"n":8123456789012345678}'
		});
		const response = await (await call(storage, 'POST', `${API}/files`, { body })).text();
		expect(response).toContain('"metadata":{"n":8123456789012345678}');
		expect(response).toContain('"text":"note"');
	});

	it('handles names outside Latin-1', async () => {
		const storage = await backend.signedIn();
		const entry = await (
			await call(storage, 'POST', `${API}/files`, { body: form('备份.zip') })
		).json();
		expect(entry.name).toBe('备份.zip');
		const restored = await call(storage, 'GET', `${API}/files/${entry.id}`);
		expect(restored.headers.get('content-disposition')).toContain("UTF-8''%E5%A4%87%E4%BB%BD.zip");
		expect(await restored.text()).toBe('zip bytes');
	});

	it('guesses the type when the part has none', async () => {
		const storage = await backend.signedIn();
		const body =
			'--B\r\nContent-Disposition: form-data; name="file"; filename="db.zip"\r\n\r\nabc\r\n--B--\r\n';
		const response = await call(storage, 'POST', `${API}/files`, {
			body,
			headers: { 'content-type': 'multipart/form-data; boundary=B' }
		});
		expect(await response.json()).toMatchObject({
			name: 'db.zip',
			mimeType: 'application/zip',
			sizeBytes: 3
		});
	});

	it.each([
		[() => form('cover.jpg', 'x', 'image/jpeg'), 415, 'unsupported_media_type'],
		[() => form('db.zip', 'x', 'application/zip', { metadata: '{bad' }), 400, 'bad_request'],
		[() => new FormData(), 400, 'bad_request']
	])('rejects a bad form (%#)', async (body, status, code) => {
		const storage = await backend.signedIn();
		await expectError(await call(storage, 'POST', `${API}/files`, { body: body() }), status, code);
		expect(backend.telegram.messages).toEqual([]);
	});

	it.each([
		['bytes=2-4', 206, '234', 'bytes 2-4/10'],
		['bytes=-3', 206, '789', 'bytes 7-9/10'],
		['bytes=8-', 206, '89', 'bytes 8-9/10'],
		['bytes=20-', 416, '', 'bytes */10']
	])('serves %s', async (range, status, text, contentRange) => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage);
		const response = await call(storage, 'GET', `${API}/files/${id}`, { headers: { range } });
		expect(response.status).toBe(status);
		expect(response.headers.get('content-range')).toBe(contentRange);
		expect(await response.text()).toBe(text);
	});

	it('restores an empty zip', async () => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage, '');
		const response = await call(storage, 'GET', `${API}/files/${id}`);
		expect(response.headers.get('content-length')).toBe('0');
		expect(await response.text()).toBe('');
	});

	it("doesn't download for HEAD", async () => {
		const storage = await backend.signedIn();
		const { id } = await uploaded(storage);
		const response = await call(storage, 'HEAD', `${API}/files/${id}`);
		expect(response.headers.get('content-length')).toBe('10');
		expect(response.body).toBeNull();
		expect(backend.telegram.count('upload.getFile')).toBe(0);
	});

	it('refuses an incomplete backup', async () => {
		const storage = await backend.signedIn();
		const { db } = await storage.groups.resolve(null);
		db.insert({
			id: 'half',
			name: 'half.zip',
			sizeBytes: 10,
			mimeType: 'application/zip',
			tgMessageId: 1,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		await expectError(await call(storage, 'GET', `${API}/files/half`), 409, 'backup_incomplete');
	});

	it('lists the index when the walk fails', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		backend.telegram.intercept = (request) => {
			if (request._ === 'messages.getHistory') throw InvocationError.rpc(500, 'INTERNAL');
		};
		expect((await (await call(storage, 'GET', `${API}/files`)).json()).files).toHaveLength(1);
	});

	it('scopes the listing and loads media by pipeline', async () => {
		const storage = await backend.signedIn();
		for (const role of ['metadata', 'media']) {
			const metadata = JSON.stringify({ pipelineId: 'p1', role });
			await call(storage, 'POST', `${API}/files`, {
				body: form(`${role}.zip`, role, 'application/zip', { metadata })
			});
		}
		const listed = await (await call(storage, 'GET', `${API}/files?scope=metadata`)).json();
		expect(listed.files.map((file: { name: string }) => file.name)).toEqual(['metadata.zip']);
		expect((await (await call(storage, 'POST', `${API}/files/load-media/p1`)).json()).name).toBe(
			'media.zip'
		);
		await expectError(
			await call(storage, 'POST', `${API}/files/load-media/none`),
			404,
			'not_found'
		);
	});

	it('wipes everything on delete-all', async () => {
		const storage = await backend.signedIn();
		await uploaded(storage);
		const json = { groupId: `channel-${CHANNEL_ID}` };
		const response = await call(storage, 'POST', `${API}/files/delete-all`, { json });
		expect(await response.json()).toEqual({ ok: true, deleted: 1 });
	});
});

describe('uploads by path', () => {
	it('uploads a file and waits', async () => {
		const storage = await backend.signedIn();
		const path = join(backend.root, 'db.zip');
		writeFileSync(path, 'abc');
		const response = await call(storage, 'POST', `${API}/files/from-path`, {
			json: { path, name: 'renamed.zip' }
		});
		expect(await response.json()).toMatchObject({
			name: 'renamed.zip',
			sizeBytes: 3,
			complete: true
		});
	});

	it('uploads in the background', async () => {
		const storage = await backend.signedIn();
		const path = join(backend.root, 'db.zip');
		writeFileSync(path, 'abc');
		const started = await (
			await call(storage, 'POST', `${API}/uploads`, { json: { path, ref: 'mine' } })
		).json();
		expect(started.snapshot).toMatchObject({
			refId: 'mine',
			status: 'running',
			transferStartedAt: null
		});
		await vi.waitFor(async () => {
			const now = await (await call(storage, 'GET', `${API}/uploads/${started.uploadId}`)).json();
			expect(now).toMatchObject({ status: 'completed', bytesUploaded: 3, chunksCompleted: 1 });
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

		const started = await (
			await call(storage, 'POST', `${API}/uploads`, { json: { path: folder } })
		).json();
		expect(started.snapshot).toMatchObject({ name: 'z.zip', refId: 'zips' });
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
		await call(storage, 'POST', `${API}/uploads`, { json: { path: folder } });
		await vi.waitFor(() =>
			expect(storage.uploads.list()[0]).toMatchObject({ name: 'ok.zip', status: 'completed' })
		);
	});

	it.each(['', 'relative.zip', '/etc/passwd', 'ROOT/../escape.zip'])(
		'rejects "%s"',
		async (path) => {
			const storage = await backend.signedIn();
			const json = { path: path.replace('ROOT', backend.root) };
			await expectError(
				await call(storage, 'POST', `${API}/uploads`, { json }),
				400,
				'bad_request'
			);
			await expectError(
				await call(storage, 'POST', `${API}/files/from-path`, { json }),
				400,
				'bad_request'
			);
		}
	);

	it('rejects a symlink out of the data root', async () => {
		const storage = await backend.signedIn();
		const link = join(backend.root, 'link.zip');
		symlinkSync('/etc/passwd', link);
		await expectError(
			await call(storage, 'POST', `${API}/uploads`, { json: { path: link } }),
			400,
			'bad_request'
		);
	});

	it('knows what is under the root', async () => {
		const inside = join(backend.root, 'file.zip');
		writeFileSync(inside, 'x');
		expect(await isUnderDataRoot(inside, backend.root)).toBe(true);
		expect(await isUnderDataRoot(backend.root, backend.root)).toBe(true);
		expect(await isUnderDataRoot(tmpdir(), backend.root)).toBe(false);
		expect(await isUnderDataRoot(`${backend.root}-sibling`, backend.root)).toBe(false);
		expect(fileNameOf('/a/b.zip/')).toBe('b.zip');
		expect(fileNameOf('/a/..')).toBeNull();
	});
});
