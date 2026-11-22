// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Long, MemoryStorage } from '@mtcute/node';
import { serializeBasicDcOption } from '@mtcute/node/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDataDir } from '../../src/lib/server/data-dir';
import { loadDotenv } from '../../src/lib/server/env';
import {
	clearCredentials,
	credentialsFromBuild,
	credentialsFromEnv,
	loadCredentials,
	saveCredentials
} from '../../src/lib/server/telegram/config';
import {
	credentialsPath,
	groupIndexPath,
	groupsPath,
	sessionPath
} from '../../src/lib/server/telegram/paths';
import { FileSession } from '../../src/lib/server/telegram/session';
import { MtcuteTransport, sessionStorage } from '../../src/lib/server/telegram/transport';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'tgb-files-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

// grammers-session 0.9's serde layout: externally tagged peers, i64 hashes, hex keys.
const KEY_HEX = 'ab'.repeat(256);
const EXISTING_SESSION =
	'{"home_dc":4,"dc_options":[' +
	`{"id":4,"ipv4":"149.154.167.92:443","ipv6":"[2001:67c:4e8:f004::a]:443","auth_key":"${KEY_HEX}"},` +
	'{"id":2,"ipv4":"149.154.167.41:443","ipv6":"[2001:67c:4e8:f002::a]:443","auth_key":null}],' +
	'"peer_infos":[{"User":{"id":4242,"auth":-8123456789012345678,"bot":false,"is_self":true}},' +
	'{"Chat":{"id":55}},{"Channel":{"id":1234567890,"auth":8123456789012345678,"kind":"Megagroup"}}],' +
	'"updates_state":{"pts":100,"qts":2,"date":1700000000,"seq":3,"channels":[{"id":1234567890,"pts":6}]}}';

function writeSession(text: string): string {
	const path = sessionPath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

describe('paths', () => {
	it('keeps every existing file name', () => {
		expect(sessionPath('/tmp/root')).toBe('/tmp/root/telegram/session.sqlite');
		expect(credentialsPath('/tmp/root')).toBe('/tmp/root/telegram/credentials.json');
		expect(groupsPath('/tmp/root')).toBe('/tmp/root/telegram/groups.json');
		expect(groupIndexPath('/tmp/root', 42, 'channel-7')).toBe(
			'/tmp/root/telegram/groups/42/channel-7.sqlite'
		);
	});

	it('resolves the data dir', () => {
		expect(resolveDataDir('/custom', () => '/home/dummy')).toBe('/custom');
		expect(resolveDataDir('', () => '/home/dummy')).toBe('/home/dummy/tg-backups');
		expect(resolveDataDir('', () => '')).toBe('tg-backups');
		const noHome = () => {
			throw new Error('no home');
		};
		expect(resolveDataDir('', noHome)).toBe('tg-backups');
		vi.stubEnv('TGB_DATA_DIR', '/from/env');
		expect(resolveDataDir()).toBe('/from/env');
	});

	it('loads the nearest .env without overriding', () => {
		writeFileSync(join(root, '.env'), 'A=file\nB=file\n');
		const nested = join(root, 'a', 'b');
		mkdirSync(nested, { recursive: true });
		const env: Record<string, string | undefined> = { A: 'real' };
		loadDotenv(nested, env);
		expect(env).toEqual({ A: 'real', B: 'file' });
	});
});

describe('credentials', () => {
	it('are null when missing', async () => {
		expect(await loadCredentials(root)).toBeNull();
	});

	it('round-trip in the existing format', async () => {
		await saveCredentials(root, { apiId: 12345, apiHash: 'deadbeef' });
		expect(readFileSync(credentialsPath(root), 'utf8')).toBe(
			'{\n  "api_id": 12345,\n  "api_hash": "deadbeef"\n}'
		);
		expect(await loadCredentials(root)).toEqual({ apiId: 12345, apiHash: 'deadbeef' });
	});

	it('reject invalid JSON without quoting it', async () => {
		mkdirSync(dirname(credentialsPath(root)), { recursive: true });
		writeFileSync(credentialsPath(root), '{"api_hash":"topsecret" oops');
		const error = await loadCredentials(root).catch((reason) => reason);
		expect(error.code).toBe('internal');
		expect(error.message).not.toContain('topsecret');
	});

	it('clear, and clear again', async () => {
		await saveCredentials(root, { apiId: 1, apiHash: 'h' });
		await clearCredentials(root);
		expect(await loadCredentials(root)).toBeNull();
		await clearCredentials(root);
	});

	it.each([
		['', ''],
		['not-a-number', 'abc'],
		['0', 'abc'],
		['-5', 'abc'],
		['2147483648', 'abc'],
		['12345', '']
	])('ignore %j / %j from the environment', (id, hash) => {
		expect(credentialsFromEnv({ TELEGRAM_API_ID: id, TELEGRAM_API_HASH: hash })).toBeNull();
	});

	it('come from the environment or the build', () => {
		const expected = { apiId: 12345, apiHash: 'abc' };
		expect(credentialsFromEnv({ TELEGRAM_API_ID: ' 12345 ', TELEGRAM_API_HASH: ' abc ' })).toEqual(
			expected
		);
		expect(credentialsFromBuild('12345', 'abc')).toEqual(expected);
		expect(credentialsFromBuild()).toBeNull();
	});
});

describe('session', () => {
	it('reads a session from earlier versions', () => {
		const session = FileSession.open(writeSession(EXISTING_SESSION));
		expect(session.homeDcId).toBe(4);
		expect(Buffer.from(session.authKey(4)!).toString('hex')).toBe(KEY_HEX);
		expect(session.authKey(2)).toBeNull();
		expect(session.dcOption(5)?.ipv4).toBe('91.108.56.104:443');
		expect(session.updatesState.pts).toBe(100);
	});

	it('rewrites it without losing or rounding anything', () => {
		const path = writeSession(EXISTING_SESSION);
		FileSession.open(path).setHomeDc(4);
		const saved = readFileSync(path, 'utf8');
		const tail = EXISTING_SESSION.slice(EXISTING_SESSION.indexOf('"peer_infos"'));
		expect(saved.endsWith(tail)).toBe(true);
		expect(saved).toContain(`"auth_key":"${KEY_HEX}"`);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('records who signed in', () => {
		const path = sessionPath(root);
		const session = FileSession.open(path);
		const accessHash = Long.fromString('-7123456789012345678');
		session.setSelf({ id: 9, accessHash, bot: false });
		session.setSelf({ id: 9, accessHash, bot: false });
		const saved = readFileSync(path, 'utf8');
		expect(saved).toContain(
			'"peer_infos":[{"User":{"id":9,"auth":-7123456789012345678,"bot":false,"is_self":true}}]'
		);
	});

	it('starts on DC 2', () => {
		const session = FileSession.open(sessionPath(root));
		expect(session.homeDcId).toBe(2);
		expect(session.updatesState).toMatchObject({ pts: 0, qts: 0 });
		expect(session.dcOption(99)).toBeNull();
	});

	it('persists home DC, keys and update state', () => {
		const path = sessionPath(root);
		const session = FileSession.open(path);
		session.setHomeDc(5, { ip: '10.0.0.5', port: 443 });
		session.setAuthKey(99, new Uint8Array(256).fill(7));
		session.setUpdatesState({ pts: 999, qts: 77, date: 200, seq: 3, channels: [] });

		const reopened = FileSession.open(path);
		expect(reopened.homeDcId).toBe(5);
		expect(reopened.dcOption(5)?.ipv4).toBe('10.0.0.5:443');
		expect(reopened.authKey(99)).toEqual(new Uint8Array(256).fill(7));
		expect(reopened.updatesState).toMatchObject({ pts: 999, qts: 77, date: 200, seq: 3 });
	});

	it('starts fresh from garbage', () => {
		expect(FileSession.open(writeSession('definitely-not-json')).homeDcId).toBe(2);
	});

	it('refuses to overwrite a session it cannot read', () => {
		mkdirSync(sessionPath(root), { recursive: true });
		expect(() => FileSession.open(sessionPath(root))).toThrow();
	});

	it('stops writing once closed', () => {
		const path = writeSession(EXISTING_SESSION);
		const session = FileSession.open(path);
		session.close();
		session.setAuthKey(4, null);
		expect(readFileSync(path, 'utf8')).toBe(EXISTING_SESSION);
	});
});

describe('mtcute on an existing session', () => {
	it('gets the existing keys and writes new ones back', async () => {
		const path = writeSession(EXISTING_SESSION);
		const storage = sessionStorage(FileSession.open(path));
		expect(Buffer.from((await storage.authKeys.get(4))!).toString('hex')).toBe(KEY_HEX);

		await storage.authKeys.set(3, new Uint8Array(256).fill(1));
		await storage.kv.set(
			'dc_main',
			serializeBasicDcOption({ id: 5, ipAddress: '91.108.56.130', port: 443 })
		);
		const saved = FileSession.open(path);
		expect(saved.authKey(3)).toEqual(new Uint8Array(256).fill(1));
		expect(saved.homeDcId).toBe(5);
		expect(saved.dcOption(5)?.ipv4).toBe('91.108.56.130:443');
		expect(storage.peers).toBeInstanceOf(new MemoryStorage().peers.constructor);
	});

	it('loads the real client on the saved DC with the saved key, offline', async () => {
		const path = writeSession(EXISTING_SESSION);
		const transport = new MtcuteTransport(FileSession.open(path), 12345, 'hash');
		const { client } = transport as unknown as {
			client: import('@mtcute/node').BaseTelegramClient;
		};
		await client.prepare();
		const exported = await client.exportSession();
		const { readStringSession } = await import('@mtcute/node/utils.js');
		const session = readStringSession(exported);
		expect(session.primaryDcs.main).toMatchObject({ id: 4, ipAddress: '149.154.167.92' });
		expect(Buffer.from(session.authKey).toString('hex')).toBe(KEY_HEX);

		await transport.close();
		await expect(transport.invoke({ _: 'help.getConfig' })).rejects.toMatchObject({
			kind: 'dropped'
		});
		expect(readFileSync(path, 'utf8')).toBe(EXISTING_SESSION);
	});
});
