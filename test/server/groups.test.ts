// @vitest-environment node
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InvocationError } from '../../src/lib/server/telegram/invocation-error';
import { groupsPath, telegramDir } from '../../src/lib/server/telegram/paths';
import type { TelegramStorage } from '../../src/lib/server/telegram/storage';
import { CHANNEL_ID } from './support/fake-telegram';
import { call, useBackend } from './support/harness';

const backend = useBackend();
const API = '/api/telegram';
const MAIN = `channel-${CHANNEL_ID}`;

async function create(storage: TelegramStorage, title: string): Promise<string> {
	const response = await call(storage, 'POST', `${API}/groups`, { json: { title } });
	expect(response.status).toBe(200);
	return (await response.json()).group.id;
}

function select(storage: TelegramStorage, id: string) {
	return call(storage, 'POST', `${API}/groups/select`, { json: { id } });
}

async function status(storage: TelegramStorage) {
	return (await call(storage, 'GET', `${API}/status`)).json();
}

async function put(storage: TelegramStorage, group: string, content: string) {
	const body = new FormData();
	body.append('file', new Blob([content], { type: 'application/zip' }), 'db.zip');
	const response = await call(storage, 'POST', `${API}/files?group=${group}`, { body });
	expect(response.status).toBe(200);
	return response.json();
}

async function list(storage: TelegramStorage, group: string) {
	return (await (await call(storage, 'GET', `${API}/files?group=${group}`)).json()).files;
}

describe('creating a group', () => {
	it('works with only an api id, a hash and a sign-in', async () => {
		const storage = await backend.open();
		await call(storage, 'POST', `${API}/credentials`, { json: { apiId: 777, apiHash: 'abc' } });
		expect(await status(storage)).toMatchObject({
			authorized: true,
			groups: [],
			activeGroupId: null
		});

		const id = await create(storage, '  My backups  ');
		expect(backend.telegram.requests('channels.createChannel')[0]).toMatchObject({
			megagroup: true,
			title: 'My backups'
		});
		expect(await status(storage)).toMatchObject({
			activeGroupId: id,
			groups: [{ id, title: 'My backups' }]
		});
		await put(storage, id, 'bytes');
		expect(await list(storage, id)).toHaveLength(1);
	});

	it('shows history and turns auto-delete off', async () => {
		const storage = await backend.withoutGroup();
		const id = await create(storage, 'Safe');
		const info = await (await call(storage, 'GET', `${API}/groups/${id}`)).json();
		expect(info).toEqual({
			id,
			title: 'Safe',
			invite: `https://t.me/+invite${id.split('-')[1]}`,
			autoDeleteSeconds: null,
			historyHidden: false
		});
	});

	it('keeps the group and warns when that setup fails', async () => {
		backend.telegram.intercept = (request) => {
			if (
				request._ === 'messages.setHistoryTTL' ||
				request._ === 'channels.togglePreHistoryHidden'
			) {
				throw InvocationError.rpc(400, 'CHAT_ADMIN_REQUIRED');
			}
		};
		const storage = await backend.withoutGroup();
		const id = await create(storage, 'Half set up');
		expect(await (await call(storage, 'GET', `${API}/groups/${id}`)).json()).toMatchObject({
			autoDeleteSeconds: 604800,
			historyHidden: true
		});
	});

	it.each([InvocationError.io('timed out'), InvocationError.rpc(420, 'FLOOD_WAIT_1')])(
		'is never retried automatically (%s)',
		async (error) => {
			backend.telegram.intercept = (request) => {
				if (request._ === 'channels.createChannel') throw error;
			};
			const storage = await backend.withoutGroup();
			const response = await call(storage, 'POST', `${API}/groups`, { json: { title: 'Once' } });
			expect(response.ok).toBe(false);
			expect(backend.telegram.count('channels.createChannel')).toBe(1);
		}
	);

	it('explains a refusal', async () => {
		backend.telegram.intercept = (request) => {
			if (request._ === 'channels.createChannel')
				throw InvocationError.rpc(400, 'CHANNELS_TOO_MUCH');
		};
		const response = await call(await backend.withoutGroup(), 'POST', `${API}/groups`, {
			json: { title: 'More' }
		});
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('too many groups');
	});

	it.each(['', '   ', 'x'.repeat(129)])('rejects the name "%s"', async (title) => {
		const response = await call(await backend.withoutGroup(), 'POST', `${API}/groups`, {
			json: { title }
		});
		expect(response.status).toBe(400);
		expect(backend.telegram.count('channels.createChannel')).toBe(0);
	});

	it('counts characters, not UTF-16 units', async () => {
		await create(await backend.withoutGroup(), '🎉'.repeat(128));
	});

	it('needs a sign-in', async () => {
		backend.telegram.authorized = false;
		const response = await call(await backend.withoutGroup(), 'POST', `${API}/groups`, {
			json: { title: 'No' }
		});
		expect(response.status).toBe(401);
		expect(backend.telegram.count('channels.createChannel')).toBe(0);
	});

	it("can't be triggered by a plain cross-site post", async () => {
		const response = await call(await backend.withoutGroup(), 'POST', `${API}/groups`, {
			body: '{"title":"x"}',
			headers: { 'content-type': 'text/plain' }
		});
		expect(response.status).toBe(415);
		expect(backend.telegram.count('channels.createChannel')).toBe(0);
	});
});

describe('using an existing group', () => {
	it('lists what the account can store in, archived and far down included', async () => {
		backend.telegram.dialogsBefore = 230;
		backend.telegram.addGroup('Archived', { archived: true });
		backend.telegram.addGroup('Read only', { megagroup: false, broadcast: true });
		backend.telegram.addGroup('Left', { left: true });
		const storage = await backend.withoutGroup();
		const { groups } = await (await call(storage, 'GET', `${API}/groups/available`)).json();
		expect(groups.map((group: { title: string }) => group.title)).toEqual(['Archived', 'tgb']);
	});

	it('finds backups already in it', async () => {
		backend.telegram.addDocument('old.zip', Buffer.from('old'));
		const storage = await backend.withoutGroup();
		expect((await select(storage, MAIN)).status).toBe(200);
		expect((await list(storage, MAIN)).map((file: { name: string }) => file.name)).toEqual([
			'old.zip'
		]);
	});

	it('works with a basic group, which always warns about history', async () => {
		backend.telegram.basicGroup = true;
		const storage = await backend.withoutGroup();
		const id = `chat-${CHANNEL_ID}`;
		expect((await select(storage, id)).status).toBe(200);
		expect((await (await call(storage, 'GET', `${API}/groups/${id}`)).json()).historyHidden).toBe(
			true
		);
	});

	it.each(['channel-999', '../../etc', 'user-5'])('refuses %s', async (id) => {
		expect((await select(await backend.withoutGroup(), id)).status).toBe(404);
	});

	it('follows a rename', async () => {
		const storage = await backend.signedIn();
		backend.telegram.mainTitle = 'Renamed';
		await call(storage, 'GET', `${API}/groups/${MAIN}`);
		expect((await status(storage)).groups).toEqual([{ id: MAIN, title: 'Renamed' }]);
	});
});

describe('several groups', () => {
	it('keeps indexes apart although message ids collide', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const b = await create(storage, 'B');
		const inA = await put(storage, a, 'content of A');
		const inB = await put(storage, b, 'content of B');

		const headA = (await storage.groups.resolve(a)).db.get(inA.id)!.tgMessageId;
		const headB = (await storage.groups.resolve(b)).db.get(inB.id)!.tgMessageId;
		expect(headA).toBe(headB);

		expect(await list(storage, a)).toEqual([inA]);
		expect(await list(storage, b)).toEqual([inB]);
		const restored = await call(storage, 'GET', `${API}/files/${inA.id}?group=${a}`);
		expect(await restored.text()).toBe('content of A');
		expect((await call(storage, 'GET', `${API}/files/${inA.id}?group=${b}`)).status).toBe(404);

		await call(storage, 'DELETE', `${API}/files/${inA.id}?group=${a}`);
		expect(await list(storage, a)).toEqual([]);
		expect(await (await call(storage, 'GET', `${API}/files/${inB.id}?group=${b}`)).text()).toBe(
			'content of B'
		);
	});

	it('works on the group named, not the selected one', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const b = await create(storage, 'B');
		expect((await status(storage)).activeGroupId).toBe(b);
		await put(storage, a, 'for A');
		expect(await list(storage, a)).toHaveLength(1);
		expect(await list(storage, b)).toHaveLength(0);
	});

	it('defaults to the selected one', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const inA = await put(storage, a, 'for A');
		expect((await (await call(storage, 'GET', `${API}/files`)).json()).files).toEqual([inA]);
	});

	it('leaves a queued upload in the group it started in', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const b = await create(storage, 'B');
		await select(storage, a);

		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		backend.telegram.intercept = async (request) => {
			if (request._ === 'upload.saveFilePart') await held;
		};
		for (const name of ['first.zip', 'second.zip']) {
			const path = join(backend.root, name);
			writeFileSync(path, name);
			const response = await call(storage, 'POST', `${API}/uploads`, { json: { path } });
			expect((await response.json()).snapshot).toMatchObject({ groupId: a, groupTitle: 'A' });
		}
		await select(storage, b);
		release();

		await vi.waitFor(() =>
			expect(storage.uploads.list().map((upload) => upload.status)).toEqual([
				'completed',
				'completed'
			])
		);
		expect(await list(storage, a)).toHaveLength(2);
		expect(await list(storage, b)).toHaveLength(0);
	});

	it('switches back, and remembers across restarts', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		await create(storage, 'B');
		await select(storage, a);
		await storage.close();

		const restarted = await backend.withoutGroup();
		const after = await status(restarted);
		expect(after.activeGroupId).toBe(a);
		expect(after.groups.map((group: { title: string }) => group.title)).toEqual(['A', 'B']);
		expect(statSync(groupsPath(backend.root)).mode & 0o777).toBe(0o600);
	});

	it("doesn't show one account's groups to another", async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		backend.telegram.user.id = 5151;
		expect(await status(storage)).toMatchObject({ groups: [], activeGroupId: null });
		expect((await call(storage, 'GET', `${API}/files?group=${a}`)).status).toBe(404);
		backend.telegram.user.id = 4242;
		expect((await status(storage)).activeGroupId).toBe(a);
	});

	it('keeps the choice through a sign-out', async () => {
		const storage = await backend.signedIn();
		await status(storage);
		await call(storage, 'POST', `${API}/auth/logout`);
		expect(await status(storage)).toMatchObject({ authorized: false, groups: [] });
		backend.telegram.authorized = true;
		expect((await status(storage)).activeGroupId).toBe(MAIN);
	});
});

describe('safety', () => {
	it.each([
		['GET', '/files'],
		['POST', '/files'],
		['GET', '/files/some-id'],
		['DELETE', '/files/some-id'],
		['POST', '/files/load-media/p1'],
		['POST', '/uploads'],
		['POST', '/files/from-path']
	])('%s %s needs a group', async (method, path) => {
		const response = await call(await backend.withoutGroup(), method, API + path);
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe('group_required');
	});

	it('refuses a group the account lost', async () => {
		backend.telegram.member = false;
		const response = await call(await backend.signedIn(), 'GET', `${API}/files`);
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe('group_unavailable');
	});

	it('notices a lost membership within the hour', async () => {
		const storage = await backend.signedIn();
		expect((await call(storage, 'GET', `${API}/files`)).status).toBe(200);
		backend.telegram.member = false;
		const now = performance.now();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 60 * 60 * 1000 + 1);
		expect((await call(storage, 'GET', `${API}/files`)).status).toBe(409);
		clock.mockRestore();
	});

	it('refuses a basic group it was removed from', async () => {
		backend.telegram.basicGroup = true;
		backend.telegram.member = false;
		expect((await call(await backend.signedIn(), 'GET', `${API}/files`)).status).toBe(409);
	});

	it.each([
		[{}, 415],
		[{ body: '', headers: { 'content-type': 'text/plain' } }, 415],
		[{ json: {} }, 422],
		[{ json: { groupId: 'channel-999' } }, 404]
	])('delete-all refuses %j', async (init, code) => {
		const storage = await backend.signedIn();
		await put(storage, MAIN, 'keep me');
		expect((await call(storage, 'POST', `${API}/files/delete-all`, init)).status).toBe(code);
		expect(backend.telegram.messages).toHaveLength(1);
	});

	it('delete-all empties only the group named', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const b = await create(storage, 'B');
		await put(storage, a, 'A');
		await put(storage, b, 'B');
		await call(storage, 'POST', `${API}/files/delete-all`, { json: { groupId: a } });
		expect(await list(storage, a)).toHaveLength(0);
		expect(await list(storage, b)).toHaveLength(1);
	});

	it.each(['not json', '{"accounts":[]}', '{"accounts":{"4242":{"groups":[{"id":"../../x"}]}}}'])(
		'survives a damaged groups.json: %s',
		async (text) => {
			mkdirSync(telegramDir(backend.root), { recursive: true });
			writeFileSync(groupsPath(backend.root), text);
			const storage = await backend.withoutGroup();
			expect(await status(storage)).toMatchObject({ groups: [], activeGroupId: null });
			expect(readFileSync(groupsPath(backend.root), 'utf8')).toBe(text);
		}
	);
});

describe('dev reload', () => {
	it('closes the old backend before starting the new code', async () => {
		vi.resetModules();
		const before = await import('../../src/lib/server/telegram/instance');
		const old = await before.getTelegramStorage();
		expect(await before.getTelegramStorage()).toBe(old);
		const close = vi.spyOn(old, 'close');

		vi.resetModules();
		const after = await import('../../src/lib/server/telegram/instance');
		const fresh = await after.getTelegramStorage();
		expect(fresh).not.toBe(old);
		expect(close).toHaveBeenCalledOnce();
		await fresh.close();
	});
});
