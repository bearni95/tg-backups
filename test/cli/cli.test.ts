// @vitest-environment node
// `tgb` end to end, against the fake Telegram.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, password } from '@inquirer/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_ID } from '../engine/support/fake-telegram';
import { useBackend } from '../engine/support/harness';

vi.mock('@inquirer/prompts', () => ({ input: vi.fn(), password: vi.fn(), confirm: vi.fn() }));

const backend = useBackend();
const MAIN = `channel-${CHANNEL_ID}`;

let out: string;

beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), 'tgb-cli-'));
	vi.mocked(input).mockReset();
	vi.mocked(password).mockReset();
	vi.mocked(confirm).mockReset();
});

afterEach(() => {
	rmSync(out, { recursive: true, force: true });
});

/** Answers the prompts in order. */
function answer(prompt: typeof input | typeof password | typeof confirm, ...answers: unknown[]) {
	const mocked = vi.mocked(prompt) as unknown as ReturnType<typeof vi.fn>;
	for (const value of answers) mocked.mockResolvedValueOnce(value);
}

async function uploadZip(name = 'db.zip', content = '0123456789') {
	const path = join(out, name);
	writeFileSync(path, content);
	const result = await backend.tgb('upload', path);
	expect(result).toMatchObject({ code: 0 });
	return result.stdout.split(/\s+/)[0];
}

describe('setup', () => {
	it('shows an empty status, and says what to do next', async () => {
		const status = await backend.tgb('status');
		expect(status.stdout).toContain('credentials  not set');
		const list = await backend.tgb('list');
		expect(list.code).toBe(1);
		expect(list.stderr).toContain('tgb credentials set');
	});

	it('saves credentials and never prints the hash', async () => {
		expect(
			(await backend.tgb('credentials', 'set', '--api-id', '777', '--api-hash', 'abc')).code
		).toBe(0);
		const shown = await backend.tgb('credentials', 'show');
		expect(shown.stdout).toBe('api_id 777');
		const status = await backend.tgb('status', '--json');
		expect(status.stdout).not.toContain('abc');
		expect(JSON.parse(status.stdout)).toMatchObject({ hasCredentials: true });
	});

	it('asks for whatever credentials were left out', async () => {
		answer(input, '777');
		answer(password, 'abc');
		await backend.tgb('credentials', 'set');
		expect((await backend.tgb('credentials', 'show')).stdout).toBe('api_id 777');
	});

	it.each(['0', '-1', 'abc', '99999999999'])('refuses the api id %s', async (id) => {
		const result = await backend.tgb('credentials', 'set', '--api-id', id, '--api-hash', 'x');
		expect(result.code).toBe(1);
	});

	it('clears credentials and the session after confirming', async () => {
		await backend.seed();
		answer(confirm, false);
		await backend.tgb('credentials', 'clear');
		expect((await backend.tgb('credentials', 'show')).code).toBe(0);
		await backend.tgb('credentials', 'clear', '--yes');
		expect((await backend.tgb('credentials', 'show')).code).toBe(1);
	});
});

describe('login', () => {
	it('knows when it is already signed in', async () => {
		await backend.seed();
		expect((await backend.tgb('login')).stdout).toContain('Already signed in');
	});

	it('signs in with a phone code, through a typo and a resend', async () => {
		backend.telegram.authorized = false;
		await backend.seed();
		answer(input, 'resend', '00000', '12345');
		const result = await backend.tgb('login', '--phone', '+12025550100');
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('Wrong code');
		expect(result.stdout).toContain('Signed in as');
		expect(backend.telegram.count('auth.resendCode')).toBe(1);
	});

	it('asks for the phone number when --phone has none', async () => {
		backend.telegram.authorized = false;
		await backend.seed();
		answer(input, '+12025550100', '12345');
		expect((await backend.tgb('login', '--phone')).stdout).toContain('Signed in as');
	});

	it('asks for the 2FA password until it is right', async () => {
		backend.telegram.authorized = false;
		backend.telegram.passwordNeeded = true;
		await backend.seed();
		answer(input, '12345');
		answer(password, 'wrong', 'secret');
		const result = await backend.tgb('login', '--phone', '+1');
		expect(result.stderr).toContain('Wrong password');
		expect(result.stdout).toContain('Signed in as');
	});

	it('starts over when the password is forgotten', async () => {
		backend.telegram.authorized = false;
		backend.telegram.passwordNeeded = true;
		await backend.seed();
		answer(input, '12345');
		answer(password, '');
		answer(confirm, true);
		const result = await backend.tgb('login', '--phone', '+1');
		expect(result.stdout).toContain('Login dropped');
	});

	it.each(['success', 'password'] as const)('signs in by QR code (%s)', async (qr) => {
		backend.telegram.authorized = false;
		backend.telegram.qr = qr;
		await backend.seed();
		answer(password, 'secret');
		const result = await backend.tgb('login');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Signed in as');
	});

	it('asks for credentials first when there are none', async () => {
		backend.telegram.authorized = false;
		backend.telegram.qr = 'success';
		answer(input, '777');
		answer(password, 'abc');
		const result = await backend.tgb('login');
		expect(result.stdout).toContain('Credentials saved.');
		expect(result.stdout).toContain('tgb groups create');
	});

	it('signs out', async () => {
		await backend.seed();
		expect((await backend.tgb('logout')).stdout).toBe('Signed out.');
	});
});

describe('groups', () => {
	it('creates, lists, switches and describes groups', async () => {
		await backend.seed(undefined, { group: false });
		expect((await backend.tgb('groups', 'create', 'Photos')).stdout).toContain('TGB-Photos');
		const available = await backend.tgb('groups', 'available');
		expect(available.stdout).toContain('TGB-main');

		expect((await backend.tgb('groups', 'use', 'TGB-main')).stdout).toContain(MAIN);
		const listed = await backend.tgb('groups', 'list');
		expect(listed.stdout).toMatch(new RegExp(`\\*\\s+${MAIN}\\s+TGB-main`));
		expect(listed.stdout).toContain('TGB-Photos');

		const info = await backend.tgb('groups', 'info', '--json');
		expect(JSON.parse(info.stdout)).toMatchObject({ id: MAIN, historyHidden: false });
	});

	it('warns about settings that put backups at risk', async () => {
		backend.telegram.basicGroup = true;
		await backend.seed();
		expect((await backend.tgb('groups', 'info')).stdout).toContain("New members can't see");
	});

	it('shares an invite link with a QR code', async () => {
		await backend.seed(undefined, { group: false });
		await backend.tgb('groups', 'create', 'Shared');
		const shared = await backend.tgb('groups', 'share');
		expect(shared.stdout).toContain('https://t.me/+invite');
		expect(shared.stdout).toContain('█');
	});
});

describe('backups', () => {
	it('uploads, lists, restores and deletes', async () => {
		await backend.seed();
		const id = await uploadZip();

		const listed = await backend.tgb('ls');
		expect(listed.stdout).toContain(id);
		expect(listed.stdout).toContain('db.zip');
		expect(JSON.parse((await backend.tgb('list', '--json')).stdout)).toMatchObject([
			{ id, name: 'db.zip', complete: true }
		]);

		const restored = await backend.tgb('restore', id, '-o', join(out, 'back'));
		expect(restored.code).toBe(0);
		expect(readFileSync(join(out, 'back'), 'utf8')).toBe('0123456789');
		expect((await backend.tgb('restore', id, '-o', join(out, 'back'))).code).toBe(1);
		expect((await backend.tgb('restore', id, '-o', join(out, 'back'), '--force')).code).toBe(0);

		answer(confirm, false);
		await backend.tgb('delete', id);
		expect((await backend.tgb('list')).stdout).toContain(id);
		expect((await backend.tgb('rm', id, '-y')).stdout).toContain(`deleted ${id}`);
		expect((await backend.tgb('list')).stdout).toBe('No backups yet.');
	});

	it('restores into a folder under the original name', async () => {
		await backend.seed();
		const id = await uploadZip('nightly.zip', 'abc');
		const folder = mkdtempSync(join(out, 'restored-'));
		const restored = await backend.tgb('restore', id, '--output', folder);
		expect(restored.stdout).toBe(join(folder, 'nightly.zip'));
		expect(statSync(join(folder, 'nightly.zip')).size).toBe(3);
	});

	it('uploads several paths into the group named', async () => {
		await backend.seed(undefined, { group: false });
		await backend.tgb('groups', 'create', 'Other');
		await backend.tgb('groups', 'use', MAIN);
		writeFileSync(join(out, 'a.zip'), 'a');
		writeFileSync(join(out, 'b.zip'), 'b');
		const result = await backend.tgb(
			'upload',
			join(out, 'a.zip'),
			join(out, 'b.zip'),
			'--group',
			'TGB-Other'
		);
		expect(result.code).toBe(0);
		expect((await backend.tgb('list', '-g', 'TGB-Other')).stdout).toContain('b.zip');
		expect((await backend.tgb('list', '-g', MAIN)).stdout).toBe('No backups yet.');
	});

	it('queues nothing when one path is bad', async () => {
		await backend.seed();
		writeFileSync(join(out, 'good.zip'), 'good');
		writeFileSync(join(out, 'notes.txt'), 'text');
		const result = await backend.tgb('upload', join(out, 'good.zip'), join(out, 'notes.txt'));
		expect(result.code).toBe(1);
		expect(backend.telegram.messages).toEqual([]);
	});

	it('refuses --name with several paths', async () => {
		await backend.seed();
		const result = await backend.tgb('upload', 'a.zip', 'b.zip', '--name', 'x.zip');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--name');
	});

	it('reports an unknown backup id', async () => {
		await backend.seed();
		expect((await backend.tgb('restore', 'nope', '-o', out)).code).toBe(1);
		expect((await backend.tgb('delete', 'nope', '-y')).stderr).toContain('no backup nope');
	});

	it('only deletes everything after the title is typed', async () => {
		await backend.seed();
		await uploadZip();
		answer(input, 'wrong');
		expect((await backend.tgb('delete-all', '-g', MAIN)).stdout).toContain('Nothing deleted');
		expect(backend.telegram.messages).toHaveLength(1);
		answer(input, 'TGB-main');
		expect((await backend.tgb('delete-all', '-g', MAIN)).stdout).toContain('Deleted 1');
	});
});

describe('transfer', () => {
	it('moves the setup to another data folder', async () => {
		await backend.seed();
		const file = join(out, 'transfer.json');
		expect((await backend.tgb('transfer', 'export', '-o', file)).code).toBe(0);
		expect(statSync(file).mode & 0o777).toBe(0o600);

		const other = join(out, 'other-root');
		expect((await backend.tgb('--data-dir', other, 'transfer', 'import', file)).code).toBe(0);
		expect((await backend.tgb('--data-dir', other, 'credentials', 'show')).stdout).toBe(
			'api_id 12345'
		);
	});

	it('exports credentials only to stdout', async () => {
		await backend.seed();
		const result = await backend.tgb('transfer', 'export', '--scope', 'credentials');
		expect(JSON.parse(result.stdout)).toMatchObject({ scope: 'credentials' });
		expect(JSON.parse(result.stdout).session).toBeUndefined();
	});

	it('refuses a file that is not a transfer', async () => {
		await backend.seed();
		const file = join(out, 'bad.json');
		writeFileSync(file, '{"kind":"other"}');
		expect((await backend.tgb('transfer', 'import', file)).code).toBe(1);
		expect((await backend.tgb('transfer', 'import', join(out, 'missing.json'))).code).toBe(1);
		expect(existsSync(join(out, 'missing.json'))).toBe(false);
	});
});
