// @vitest-environment node
// `tgb tracked …` and the menus, against the fake Telegram.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalCheck } from '../../src/cli/program';
import { useBackend } from '../engine/support/harness';

vi.mock('@inquirer/prompts', () => ({
	input: vi.fn(),
	password: vi.fn(),
	confirm: vi.fn(),
	select: vi.fn(),
	checkbox: vi.fn()
}));

const backend = useBackend();
let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'tgb-cli-tracked-'));
	for (const prompt of [input, confirm, select, checkbox]) vi.mocked(prompt).mockReset();
});

afterEach(() => {
	useTerminalCheck(undefined);
	rmSync(work, { recursive: true, force: true });
});

function answer(prompt: unknown, ...answers: unknown[]) {
	const mocked = prompt as ReturnType<typeof vi.fn>;
	for (const value of answers) mocked.mockResolvedValueOnce(value);
}

const crontab = () => readFileSync(join(backend.root, 'crontab'), 'utf8');

describe('tgb tracked', () => {
	it('adds a path, schedules it in the crontab, and lists it', async () => {
		await backend.seed();
		const path = join(work, 'notes.txt');
		writeFileSync(path, 'hi');
		const added = await backend.tgb('tracked', 'add', path, '--schedule', '15 4 * * *');
		expect(added.code).toBe(0);
		const id = added.stdout.split(/\s+/)[0];
		expect(added.stdout).toContain('every day at 04:15 to TGB-main');

		const line = crontab()
			.split('\n')
			.find((text) => text.includes(`tracked run ${id}`))!;
		expect(line.startsWith('15 4 * * * ')).toBe(true);
		expect(line).toContain(`--data-dir ${backend.root}`);

		const listed = JSON.parse((await backend.tgb('tracked', 'list', '--json')).stdout);
		expect(listed).toMatchObject([{ id, path, schedule: '15 4 * * *' }]);

		await backend.tgb('tracked', 'schedule', id, 'hourly');
		expect(crontab()).toContain('0 * * * * ');

		expect((await backend.tgb('tracked', 'remove', id, '--yes')).code).toBe(0);
		expect(crontab()).toBe('');
	});

	it('refuses a bad schedule', async () => {
		await backend.seed();
		const result = await backend.tgb('tracked', 'add', work, '--schedule', 'often');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('five fields');
	});

	it('backs up now, and reports a missing path to the group with exit code 1', async () => {
		await backend.seed();
		const path = join(work, 'data.json');
		writeFileSync(path, '{}');
		const id = (await backend.tgb('tracked', 'add', path)).stdout.split(/\s+/)[0];

		const ran = await backend.tgb('tracked', 'run', id);
		expect(ran).toMatchObject({ code: 0 });
		expect(ran.stdout).toContain('data.json.zip  uploaded');
		expect((await backend.tgb('tracked', 'run')).stdout).toContain('unchanged');

		rmSync(path);
		const missing = await backend.tgb('tracked', 'run', id);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain(`missing: ${path}`);
		expect(backend.telegram.captions().at(-1)).toContain(`Path: ${path}`);
	});
});

describe('menu', () => {
	it('needs a terminal', async () => {
		useTerminalCheck(() => false);
		const result = await backend.tgb();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('need a terminal');
	});

	it('marks a file for backup through the menus', async () => {
		await backend.seed();
		useTerminalCheck(() => true);
		const path = join(work, 'diary.txt');
		writeFileSync(path, 'dear diary');

		answer(select, 'tracked', 'add', 'channel-' + backend.telegram.chat.id, 'weekly', 2);
		answer(input, path, '21:30');
		answer(confirm, true);
		answer(select, 'list', 'back', 'quit');

		const result = await backend.tgb();
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('every Tuesday at 21:30, to TGB-main');
		expect(result.stdout).toContain('diary.txt.zip  uploaded');
		expect(crontab()).toContain('30 21 * * 2 ');
	});

	it('shows an error and carries on', async () => {
		await backend.seed();
		useTerminalCheck(() => true);
		answer(select, 'tracked', 'schedule', 'back', 'quit');
		const result = await backend.tgb();
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Nothing tracked yet.');
	});
});
