// Reading and writing the user's crontab, and keeping tgb's block in step with tracked.json.
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { StorageError } from '$lib/telegram/errors';
import { replaceCronBlock, type CronInvocation } from '$utils/cron/crontabBlock';
import { cronLogPath, type TrackedStore } from './store';

export interface CrontabIO {
	read(): Promise<string>;
	write(text: string): Promise<void>;
}

const run = promisify(execFile);

function unavailable(error: unknown): StorageError {
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return StorageError.badRequest(
			'crontab is not installed, so tracked paths cannot be scheduled'
		);
	}
	return StorageError.from(error);
}

/** `crontab -l` and `crontab -`. */
export const systemCrontab: CrontabIO = {
	async read() {
		try {
			return (await run('crontab', ['-l'])).stdout;
		} catch (error) {
			// What crontab says, and exits 1 with, for a user without one yet.
			if (/no crontab for/i.test(String((error as { stderr?: string }).stderr))) return '';
			throw unavailable(error);
		}
	},
	write(text) {
		return new Promise((resolve, reject) => {
			const child = spawn('crontab', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', (chunk) => (stderr += chunk));
			child.on('error', (error) => reject(unavailable(error)));
			child.on('close', (code) =>
				code === 0
					? resolve()
					: reject(StorageError.badRequest(`crontab refused the new table: ${stderr.trim()}`))
			);
			child.stdin.end(text);
		});
	}
};

/** A plain file in place of the crontab. Tests use it, so they never touch the real one. */
export function fileCrontab(path: string): CrontabIO {
	return {
		read: () =>
			readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return '';
				throw error;
			}),
		write: (text) => writeFile(path, text)
	};
}

/** `TGB_CRONTAB_FILE`, when set, stands in for the crontab. */
export function defaultCrontab(): CrontabIO {
	const file = process.env.TGB_CRONTAB_FILE;
	return file ? fileCrontab(file) : systemCrontab;
}

export interface CronTarget {
	/** The node binary and `tgb` script cron should run. */
	node: string;
	script: string;
}

/** Rewrite tgb's block for this data root from tracked.json. Returns the lines written. */
export async function syncCrontab(
	store: TrackedStore,
	target: CronTarget,
	crontab: CrontabIO = defaultCrontab()
): Promise<string> {
	const invocation: CronInvocation = {
		...target,
		dataRoot: store.dataRoot,
		logFile: cronLogPath(store.dataRoot)
	};
	const jobs = store.list().map((entry) => ({ id: String(entry.id), schedule: entry.schedule }));
	const next = replaceCronBlock(await crontab.read(), jobs, invocation);
	await crontab.write(next);
	return next;
}
