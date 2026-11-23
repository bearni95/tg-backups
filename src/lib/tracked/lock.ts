// Cron can start several runs at once, and they share the session and the index.
// They take turns through a lock file holding the owner's pid.
import { open, readFile, rm } from 'node:fs/promises';
import { sleep } from '$lib/sync';
import { StorageError } from '$lib/telegram/errors';
import { runLockPath } from './store';

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, under another user.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function tryAcquire(path: string): Promise<boolean> {
	try {
		const handle = await open(path, 'wx');
		await handle.writeFile(String(process.pid));
		await handle.close();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const owner = Number((await readFile(path, 'utf8').catch(() => '')).trim());
	// A run that died without cleaning up.
	if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
		await rm(path, { force: true });
	}
	return false;
}

/** Run `action` once no other tracked run of this data root is going. */
export async function withRunLock<T>(
	dataRoot: string,
	action: () => Promise<T>,
	{ waitMs = 6 * 60 * 60 * 1000, pollMs = 2000 } = {}
): Promise<T> {
	const path = runLockPath(dataRoot);
	const deadline = Date.now() + waitMs;
	while (!(await tryAcquire(path))) {
		if (Date.now() >= deadline) {
			throw StorageError.badRequest('another tracked backup run is still going');
		}
		await sleep(pollMs);
	}
	try {
		return await action();
	} finally {
		await rm(path, { force: true });
	}
}
