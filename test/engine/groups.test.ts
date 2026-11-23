// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveGroup } from '../../src/cli/context';
import { listFiles, uploadedEntry } from '../../src/lib/telegram/catalog';
import { InvocationError } from '../../src/lib/telegram/invocation-error';
import { startUpload } from '../../src/lib/telegram/local-paths';
import { groupsPath, telegramDir } from '../../src/lib/telegram/paths';
import { readStatus } from '../../src/lib/telegram/status';
import type { TelegramStorage } from '../../src/lib/telegram/storage';
import { CHANNEL_ID } from './support/fake-telegram';
import { settledUpload, useBackend } from './support/harness';

const backend = useBackend();
const MAIN = `channel-${CHANNEL_ID}`;

async function create(storage: TelegramStorage, title: string): Promise<string> {
	return (await storage.groups.create(title)).id;
}

function select(storage: TelegramStorage, id: string) {
	return storage.groups.select(id);
}

function status(storage: TelegramStorage) {
	return readStatus(storage);
}

/** `tgb upload --group <group>` of a zip called db.zip. */
async function put(storage: TelegramStorage, group: string, content: string) {
	const backupGroup = await storage.groups.resolve(group);
	const path = join(mkdtempSync(join(backend.root, 'put-')), 'db.zip');
	writeFileSync(path, content);
	const [started] = await startUpload(storage, backupGroup, { path });
	const done = await settledUpload(storage, started.uploadId);
	expect(done.status).toBe('completed');
	return uploadedEntry(backupGroup, done.fileId!);
}

async function list(storage: TelegramStorage, group: string | null) {
	return listFiles(await storage.groups.resolve(group));
}

async function read(storage: TelegramStorage, group: string, id: string) {
	const chunks: Buffer[] = [];
	for await (const chunk of await (await storage.groups.resolve(group)).files.download(id)) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString();
}

describe('creating a group', () => {
	it('works with only an api id, a hash and a sign-in', async () => {
		const storage = await backend.open();
		await storage.setCredentials({ apiId: 777, apiHash: 'abc' });
		expect(await status(storage)).toMatchObject({
			authorized: true,
			groups: [],
			activeGroupId: null
		});

		const id = await create(storage, '  My backups  ');
		expect(backend.telegram.requests('channels.createChannel')[0]).toMatchObject({
			megagroup: true,
			title: 'TGB-My backups'
		});
		expect(await status(storage)).toMatchObject({
			activeGroupId: id,
			groups: [{ id, title: 'TGB-My backups' }]
		});
		await put(storage, id, 'bytes');
		expect(await list(storage, id)).toHaveLength(1);
	});

	it('shows history and turns auto-delete off', async () => {
		const storage = await backend.withoutGroup();
		const id = await create(storage, 'Safe');
		expect(await storage.groups.info(id)).toEqual({
			id,
			title: 'TGB-Safe',
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
		expect(await storage.groups.info(id)).toMatchObject({
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
			await expect(storage.groups.create('Once')).rejects.toThrow();
			expect(backend.telegram.count('channels.createChannel')).toBe(1);
		}
	);

	it('explains a refusal', async () => {
		backend.telegram.intercept = (request) => {
			if (request._ === 'channels.createChannel')
				throw InvocationError.rpc(400, 'CHANNELS_TOO_MUCH');
		};
		const storage = await backend.withoutGroup();
		await expect(storage.groups.create('More')).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('too many groups')
		});
	});

	it.each([
		['Photos', 'TGB-Photos'],
		['TGB-Photos', 'TGB-Photos'],
		[' TGB- Photos ', 'TGB-Photos'],
		['tgb-Photos', 'TGB-tgb-Photos'],
		['TGB-TGB-Photos', 'TGB-TGB-Photos']
	])('names "%s" as "%s"', async (given, title) => {
		await create(await backend.withoutGroup(), given);
		expect(backend.telegram.requests('channels.createChannel')[0]).toMatchObject({ title });
	});

	it.each(['', '   ', 'TGB-', ' TGB-  ', 'x'.repeat(125), `TGB-${'x'.repeat(125)}`])(
		'rejects the name "%s"',
		async (title) => {
			const storage = await backend.withoutGroup();
			await expect(storage.groups.create(title)).rejects.toMatchObject({ code: 'bad_request' });
			expect(backend.telegram.count('channels.createChannel')).toBe(0);
		}
	);

	it('counts characters, not UTF-16 units', async () => {
		await create(await backend.withoutGroup(), '🎉'.repeat(124));
	});

	it('needs a sign-in', async () => {
		backend.telegram.authorized = false;
		const result = await backend.tgb('groups', 'create', 'No');
		expect(result.code).toBe(1);
		expect(backend.telegram.count('channels.createChannel')).toBe(0);
	});
});

describe('using an existing group', () => {
	it('lists what the account can store in, archived and far down included', async () => {
		backend.telegram.dialogsBefore = 230;
		backend.telegram.addGroup('TGB-Archived', { archived: true });
		backend.telegram.addGroup('TGB-Read only', { megagroup: false, broadcast: true });
		backend.telegram.addGroup('TGB-Left', { left: true });
		const storage = await backend.withoutGroup();
		expect((await storage.groups.available()).map((group) => group.title)).toEqual([
			'TGB-Archived',
			'TGB-main'
		]);
	});

	it.each(['Family', 'tgb-lower', 'Tgb-mixed', 'TGB_underscore', ' TGB-space', 'My TGB-group'])(
		'neither offers nor accepts "%s"',
		async (title) => {
			const id = `channel-${backend.telegram.addGroup(title)}`;
			const storage = await backend.withoutGroup();
			expect(await storage.groups.available()).toEqual([{ id: MAIN, title: 'TGB-main' }]);
			await expect(select(storage, id)).rejects.toMatchObject({ code: 'group_not_found' });
		}
	);

	it('still switches to a saved group without the prefix', async () => {
		backend.telegram.mainTitle = 'Old backups';
		expect(await select(await backend.signedIn(), MAIN)).toMatchObject({ id: MAIN });
	});

	it('finds backups already in it', async () => {
		backend.telegram.addDocument('old.zip', Buffer.from('old'));
		const storage = await backend.withoutGroup();
		await select(storage, MAIN);
		expect((await list(storage, MAIN)).map((file) => file.name)).toEqual(['old.zip']);
	});

	it('works with a basic group, which always warns about history', async () => {
		backend.telegram.basicGroup = true;
		const storage = await backend.withoutGroup();
		const id = `chat-${CHANNEL_ID}`;
		await select(storage, id);
		expect((await storage.groups.info(id)).historyHidden).toBe(true);
	});

	it.each(['channel-999', '../../etc', 'user-5'])('refuses %s', async (id) => {
		await expect(select(await backend.withoutGroup(), id)).rejects.toMatchObject({
			code: 'group_not_found'
		});
	});

	it('follows a rename', async () => {
		const storage = await backend.signedIn();
		backend.telegram.mainTitle = 'Renamed';
		await storage.groups.info(MAIN);
		expect((await status(storage)).groups).toEqual([{ id: MAIN, title: 'Renamed' }]);
	});

	it('is found by title as well as id', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		await create(storage, 'B');
		expect((await resolveGroup(storage, 'TGB-A')).id).toBe(a);
		expect((await resolveGroup(storage, a)).id).toBe(a);
		await expect(resolveGroup(storage, 'TGB-none')).rejects.toMatchObject({
			code: 'group_not_found'
		});
	});

	it('refuses an ambiguous title', async () => {
		const storage = await backend.withoutGroup();
		await create(storage, 'Same');
		await create(storage, 'Same');
		await expect(resolveGroup(storage, 'TGB-Same')).rejects.toMatchObject({
			message: expect.stringContaining('by id')
		});
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
		expect(await read(storage, a, inA.id)).toBe('content of A');
		await expect(read(storage, b, inA.id)).rejects.toMatchObject({ code: 'not_found' });

		await (await storage.groups.resolve(a)).files.delete(inA.id);
		expect(await list(storage, a)).toEqual([]);
		expect(await read(storage, b, inB.id)).toBe('content of B');
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
		expect(await list(storage, null)).toEqual([inA]);
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
		const group = await storage.groups.resolve(null);
		for (const name of ['first.zip', 'second.zip']) {
			const path = join(backend.root, name);
			writeFileSync(path, name);
			const [started] = await startUpload(storage, group, { path });
			expect(started).toMatchObject({ groupId: a, groupTitle: 'TGB-A' });
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
		expect(after.groups.map((group) => group.title)).toEqual(['TGB-A', 'TGB-B']);
		expect(statSync(groupsPath(backend.root)).mode & 0o777).toBe(0o600);
	});

	it("doesn't show one account's groups to another", async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		backend.telegram.user.id = 5151;
		expect(await status(storage)).toMatchObject({ groups: [], activeGroupId: null });
		await expect(storage.groups.resolve(a)).rejects.toMatchObject({ code: 'group_not_found' });
		backend.telegram.user.id = 4242;
		expect((await status(storage)).activeGroupId).toBe(a);
	});

	it('keeps the choice through a sign-out', async () => {
		const storage = await backend.signedIn();
		await status(storage);
		await storage.logout();
		expect(await status(storage)).toMatchObject({ authorized: false, groups: [] });
		backend.telegram.authorized = true;
		expect((await status(storage)).activeGroupId).toBe(MAIN);
	});
});

describe('safety', () => {
	it.each([
		['list'],
		['upload', '/tmp/x.zip'],
		['restore', 'some-id'],
		['delete', 'some-id', '-y']
	])('`tgb %s` needs a group', async (...args) => {
		await backend.seed(undefined, { group: false });
		const result = await backend.tgb(...args);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('tgb groups create');
	});

	it('refuses a group the account lost', async () => {
		backend.telegram.member = false;
		await expect(list(await backend.signedIn(), null)).rejects.toMatchObject({
			code: 'group_unavailable'
		});
	});

	it('notices a lost membership within the hour', async () => {
		const storage = await backend.signedIn();
		await list(storage, null);
		backend.telegram.member = false;
		const now = performance.now();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 60 * 60 * 1000 + 1);
		await expect(list(storage, null)).rejects.toMatchObject({ code: 'group_unavailable' });
		clock.mockRestore();
	});

	it('refuses a basic group it was removed from', async () => {
		backend.telegram.basicGroup = true;
		backend.telegram.member = false;
		await expect(list(await backend.signedIn(), null)).rejects.toMatchObject({
			code: 'group_unavailable'
		});
	});

	it('delete-all never defaults to the chosen group', async () => {
		const storage = await backend.signedIn();
		await put(storage, MAIN, 'keep me');
		const result = await backend.tgb('delete-all', '--yes');
		expect(result.code).not.toBe(0);
		expect(backend.telegram.messages).toHaveLength(1);
	});

	it('delete-all refuses an unknown group', async () => {
		const storage = await backend.signedIn();
		await put(storage, MAIN, 'keep me');
		const result = await backend.tgb('delete-all', '--group', 'channel-999', '--yes');
		expect(result.code).toBe(1);
		expect(backend.telegram.messages).toHaveLength(1);
	});

	it('delete-all empties only the group named', async () => {
		const storage = await backend.withoutGroup();
		const a = await create(storage, 'A');
		const b = await create(storage, 'B');
		await put(storage, a, 'A');
		await put(storage, b, 'B');
		expect((await backend.tgb('delete-all', '--group', a, '--yes')).code).toBe(0);
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
