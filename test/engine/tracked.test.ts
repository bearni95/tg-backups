// @vitest-environment node
// Tracked paths: zipping, skipping what is unchanged, and reporting what is missing.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withRunLock } from '../../src/lib/tracked/lock';
import { runTracked } from '../../src/lib/tracked/run';
import { runLockPath, stagingDir, TrackedStore } from '../../src/lib/tracked/store';
import { trackPath } from '../../src/lib/tracked/track';
import { listFiles } from '../../src/lib/telegram/catalog';
import { useBackend } from './support/harness';

const backend = useBackend();
let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'tgb-tracked-'));
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

async function setup() {
	const storage = await backend.signedIn();
	return { storage, store: new TrackedStore(storage.dataRoot) };
}

describe('tracking', () => {
	it('records the path, the group and the schedule', async () => {
		const { storage, store } = await setup();
		const path = join(work, 'notes.txt');
		writeFileSync(path, 'hello');
		const entry = await trackPath(storage, store, { path, schedule: 'weekly' });
		expect(entry).toMatchObject({
			path,
			kind: 'file',
			groupTitle: 'TGB-main',
			schedule: '0 3 * * 0',
			lastSizeBytes: 5
		});
		expect(store.list()).toEqual([entry]);
	});

	it('refuses a path that is missing, already tracked, or in the app data', async () => {
		const { storage, store } = await setup();
		await expect(
			trackPath(storage, store, { path: join(work, 'nope'), schedule: 'daily' })
		).rejects.toThrow('does not exist');
		await trackPath(storage, store, { path: work, schedule: 'daily' });
		await expect(trackPath(storage, store, { path: work, schedule: 'daily' })).rejects.toThrow(
			'already tracked'
		);
		await expect(
			trackPath(storage, store, { path: join(storage.dataRoot, 'telegram'), schedule: 'daily' })
		).rejects.toThrow("app's own data");
		await expect(trackPath(storage, store, { path: work, schedule: '99 * * * *' })).rejects.toThrow(
			'minute'
		);
	});
});

describe('running', () => {
	it('zips a folder, uploads it, and skips it while nothing changes', async () => {
		const { storage, store } = await setup();
		const folder = join(work, 'docs');
		mkdirSync(join(folder, 'sub'), { recursive: true });
		writeFileSync(join(folder, 'a.txt'), 'alpha');
		writeFileSync(join(folder, 'sub', 'b.txt'), 'beta');
		const { id } = await trackPath(storage, store, { path: folder, schedule: 'daily' });

		const first = await runTracked(storage, store, String(id));
		expect(first).toMatchObject({ status: 'uploaded', name: 'docs.zip' });
		const group = await storage.groups.resolve(null);
		const files = await listFiles(group);
		expect(files.map((file) => file.name)).toEqual(['docs.zip']);
		expect(readdirSync(stagingDir(storage.dataRoot))).toEqual([]);

		const second = await runTracked(storage, store, String(id));
		expect(second).toMatchObject({ status: 'unchanged', backupId: files[0].id });

		writeFileSync(join(folder, 'a.txt'), 'alpha, edited');
		const later = new Date(Date.now() + 60_000);
		utimesSync(join(folder, 'a.txt'), later, later);
		expect((await runTracked(storage, store, String(id))).status).toBe('uploaded');
		expect(await listFiles(group)).toHaveLength(2);
		expect(store.require(String(id))).toMatchObject({ lastStatus: 'uploaded', lastError: null });
	});

	it('uploads a zip as it is', async () => {
		const { storage, store } = await setup();
		const path = join(work, 'db.zip');
		writeFileSync(path, 'zip bytes');
		const { id } = await trackPath(storage, store, { path, schedule: 'hourly' });
		expect(await runTracked(storage, store, String(id))).toMatchObject({
			status: 'uploaded',
			name: 'db.zip'
		});
		const [file] = await listFiles(await storage.groups.resolve(null));
		expect(file).toMatchObject({ name: 'db.zip', sizeBytes: 9 });
	});

	it('tells the group everything it knows about a path that has gone', async () => {
		const { storage, store } = await setup();
		const path = join(work, 'report.csv');
		writeFileSync(path, '1,2,3');
		const { id } = await trackPath(storage, store, { path, schedule: '30 2 * * *' });
		await runTracked(storage, store, String(id));
		const before = store.require(String(id));
		rmSync(path);

		const outcome = await runTracked(storage, store, String(id), {
			host: 'box',
			now: () => new Date('2026-11-23T02:30:00Z')
		});
		expect(outcome.status).toBe('missing');

		const message = backend.telegram.captions().at(-1)!;
		expect(message).toContain('not found');
		for (const text of [
			`Path: ${path}`,
			'Kind: file',
			'Reason: ENOENT',
			`Tracked id: ${id}`,
			'Machine: box',
			'Checked at: 2026-11-23T02:30:00.000Z',
			'Schedule: 30 2 * * * (every day at 02:30)',
			'Group: TGB-main',
			`Last backup: ${before.lastBackupAt} (id ${before.lastBackupId})`,
			'Last known size: 5 B (5 bytes)',
			`Last known modification: ${before.lastModifiedAt}`
		]) {
			expect(message).toContain(text);
		}
		expect(store.require(String(id))).toMatchObject({ lastStatus: 'missing' });
		// The text message isn't taken for a backup.
		expect(await listFiles(await storage.groups.resolve(null))).toHaveLength(1);
	});
});

describe('run lock', () => {
	it('takes turns, and takes over from a run that died', async () => {
		const root = work;
		const order: string[] = [];
		await Promise.all([
			withRunLock(root, async () => {
				order.push('a start');
				await new Promise((resolve) => setTimeout(resolve, 50));
				order.push('a end');
			}),
			new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
				withRunLock(root, async () => order.push('b'), { pollMs: 10 })
			)
		]);
		expect(order).toEqual(['a start', 'a end', 'b']);
		expect(existsSync(runLockPath(root))).toBe(false);

		writeFileSync(runLockPath(root), '999999999');
		expect(await withRunLock(root, async () => 'ran', { pollMs: 10 })).toBe('ran');
	});
});
