// Local paths backed up on a cron schedule.
import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { describeError } from '$lib/logger';
import { syncCrontab } from '$lib/tracked/crontab';
import { withRunLock } from '$lib/tracked/lock';
import { runTracked } from '$lib/tracked/run';
import { TrackedStore } from '$lib/tracked/store';
import { reschedule, trackPath } from '$lib/tracked/track';
import type { TelegramStorage } from '$lib/telegram/storage';
import { StorageError } from '$lib/telegram/errors';
import { cliDisplayAdapter } from '$adapters/classes/cli-display.adapter';
import { describeSchedule } from '$utils/cron/schedule';
import { printJson, resolveGroup, withStorage } from '../context';
import { cronTarget, missingBuildNote } from '../cron-command';
import { watchUploads } from '../progress';

const SCHEDULE_HELP =
	'hourly, daily (03:00), weekly (Sunday 03:00), monthly (the 1st, 03:00), or a cron expression like "30 2 * * *"';

export function trackedStore(storage: TelegramStorage): TrackedStore {
	return new TrackedStore(storage.dataRoot);
}

/**
 * Bring the crontab in step with tracked.json. A crontab that can't be written
 * is a warning: the change itself is saved, and `tgb tracked sync` retries.
 */
export async function syncCron(store: TrackedStore): Promise<boolean> {
	const target = cronTarget();
	try {
		await syncCrontab(store, target);
	} catch (error) {
		console.error(
			`warning: the crontab was not updated: ${describeError(error)}\nFix that, then run \`tgb tracked sync\`.`
		);
		return false;
	}
	if (!target.built) console.error(missingBuildNote(target.script));
	return true;
}

/** Run each, one after another, under the lock cron runs share. Returns whether all went well. */
export async function runAndReport(
	storage: TelegramStorage,
	store: TrackedStore,
	ids: string[]
): Promise<boolean> {
	return withRunLock(storage.dataRoot, async () => {
		let allOk = true;
		for (const id of ids) {
			const entry = store.require(id);
			console.error(`Backing up ${entry.path} to ${entry.groupTitle}.`);
			let outcome;
			try {
				outcome = await runTracked(storage, store, id, {
					watch: async (uploadId) => (await watchUploads(storage.uploads, [uploadId]))[0]
				});
			} catch (error) {
				outcome = { status: 'failed' as const, entry, error: StorageError.from(error).message };
			}
			const { ok, line } = cliDisplayAdapter.trackedOutcome(outcome);
			if (ok) console.log(line);
			else console.error(line);
			allOk &&= ok;
		}
		return allOk;
	});
}

export function registerTrackedCommands(program: Command): void {
	const tracked = program
		.command('tracked')
		.description('local files and folders backed up on a cron schedule');

	tracked
		.command('list', { isDefault: true })
		.description('the tracked paths, their schedules and last runs')
		.option('--json', 'print JSON')
		.action((options: { json?: boolean }) =>
			withStorage(async (storage) => {
				const entries = trackedStore(storage).list();
				if (options.json) return printJson(entries);
				console.log(cliDisplayAdapter.trackedTable(entries));
			})
		);

	tracked
		.command('add')
		.argument('<path>', 'a file or folder; a zip is uploaded as it is, anything else is zipped')
		.description('mark a path for backup, and schedule it in the crontab')
		.option('-s, --schedule <schedule>', SCHEDULE_HELP, 'daily')
		.option('-g, --group <group>', 'group id or title; the chosen one by default')
		.action((path: string, options: { schedule: string; group?: string }) =>
			withStorage(async (storage) => {
				const group = await resolveGroup(storage, options.group);
				const store = trackedStore(storage);
				const entry = await trackPath(storage, store, {
					path,
					schedule: options.schedule,
					groupId: group.id
				});
				console.log(
					`${entry.id}  ${entry.path}  ${describeSchedule(entry.schedule)} to ${entry.groupTitle}`
				);
				await syncCron(store);
			})
		);

	tracked
		.command('schedule')
		.argument('<id>', 'tracked id, from `tgb tracked list`')
		.argument('<schedule>', SCHEDULE_HELP)
		.description('change how often a tracked path is backed up')
		.action((id: string, schedule: string) =>
			withStorage(async (storage) => {
				const store = trackedStore(storage);
				const entry = reschedule(store, id, schedule);
				console.log(`${entry.id}  ${entry.path}  ${describeSchedule(entry.schedule)}`);
				await syncCron(store);
			})
		);

	tracked
		.command('remove')
		.alias('rm')
		.argument('<ids...>', 'tracked ids, from `tgb tracked list`')
		.description('stop backing paths up; backups already made stay in the group')
		.option('-y, --yes', 'do not ask for confirmation')
		.action((ids: string[], options: { yes?: boolean }) =>
			withStorage(async (storage) => {
				const store = trackedStore(storage);
				const entries = ids.map((id) => store.require(id));
				if (!options.yes) {
					console.log(cliDisplayAdapter.trackedTable(entries));
					const sure = await confirm({
						message: `Stop backing up ${entries.length === 1 ? 'this path' : `these ${entries.length} paths`}?`,
						default: false
					});
					if (!sure) return;
				}
				for (const entry of entries) {
					store.remove(String(entry.id));
					console.log(`untracked ${entry.id}  ${entry.path}`);
				}
				await syncCron(store);
			})
		);

	tracked
		.command('run')
		.argument('[ids...]', 'tracked ids; every tracked path when left out')
		.description(
			'back up tracked paths now (what cron runs); a missing one is reported to its group'
		)
		.action((ids: string[]) =>
			withStorage(async (storage) => {
				const store = trackedStore(storage);
				const chosen = ids.length > 0 ? ids : store.list().map((entry) => String(entry.id));
				if (chosen.length === 0) {
					console.error('Nothing tracked yet. Add a path with `tgb tracked add <path>`.');
					return;
				}
				if (!(await runAndReport(storage, store, chosen))) process.exitCode = 1;
			})
		);

	tracked
		.command('sync')
		.description("rewrite tgb's lines in the crontab from the tracked paths")
		.action(() =>
			withStorage(async (storage) => {
				const store = trackedStore(storage);
				if (!(await syncCron(store))) {
					process.exitCode = 1;
					return;
				}
				console.log(`Crontab has ${store.list().length} tgb job(s).`);
			})
		);
}
