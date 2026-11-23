// `tgb` with no command: menus for everything the commands do.
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { listFiles } from '$lib/telegram/catalog';
import { restoreTarget } from '$lib/telegram/restore';
import { readStatus } from '$lib/telegram/status';
import type { TelegramStorage } from '$lib/telegram/storage';
import { inspectTrackable } from '$lib/tracked/run';
import type { TrackedStore } from '$lib/tracked/store';
import { reschedule, trackPath } from '$lib/tracked/track';
import { cliDisplayAdapter } from '$adapters/classes/cli-display.adapter';
import { formatBytes } from '$utils/format';
import { cronProblem, describeSchedule, parseClock } from '$utils/cron/schedule';
import type { TelegramGroup } from '$types/telegram.type';
import { askCredentials, phoneLogin, qrLogin } from './commands/auth';
import { restoreBackup, uploadPaths } from './commands/backups';
import { runAndReport, syncCron, trackedStore } from './commands/tracked';
import { describeFailure } from './context';
import { terminalQr } from './qr';

const BACK = { name: 'Back', value: 'back' } as const;

function isPromptExit(error: unknown): boolean {
	return error instanceof Error && error.name === 'ExitPromptError';
}

/** One menu action. Its errors are shown and the menu carries on; Ctrl+C still leaves. */
async function attempt(action: () => Promise<unknown>): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (isPromptExit(error)) throw error;
		console.error(`error: ${describeFailure(error)}`);
	} finally {
		// A command helper may have set it; the menu itself keeps going.
		process.exitCode = undefined;
	}
}

async function existingPath(value: string): Promise<true | string> {
	if (value.trim() === '') return 'Enter a path';
	return (await stat(resolve(value.trim())).catch(() => null)) ? true : 'Nothing is at that path';
}

// Sign-in.

async function signIn(storage: TelegramStorage): Promise<boolean> {
	if (!storage.credentials) {
		console.error('Not set up yet: tgb needs an API id and hash to talk to Telegram.');
		await askCredentials(storage);
	}
	const how = await select({
		message: 'Sign in to Telegram',
		choices: [
			{ name: 'Scan a QR code with the Telegram app', value: 'qr' },
			{ name: 'Get a code on my phone number', value: 'phone' },
			{ name: 'Quit', value: 'quit' }
		]
	});
	if (how === 'quit') return false;
	if (how === 'qr') await qrLogin(storage);
	else await phoneLogin(storage, await input({ message: 'Phone number, with country code' }));
	return true;
}

// Groups.

async function chooseKnownGroup(
	storage: TelegramStorage,
	message: string
): Promise<TelegramGroup | null> {
	const { groups, activeGroupId } = storage.groups.overview(
		await storage.requireClient().account()
	);
	if (groups.length === 0) {
		console.error('No groups yet. Create or choose one under Groups.');
		return null;
	}
	const id = await select({
		message,
		default: activeGroupId ?? undefined,
		choices: groups.map((group) => ({
			name: `${group.title}${group.id === activeGroupId ? '  (chosen)' : ''}`,
			value: group.id
		}))
	});
	return groups.find((group) => group.id === id) ?? null;
}

async function groupsMenu(storage: TelegramStorage): Promise<void> {
	for (;;) {
		const action = await select({
			message: 'Groups',
			choices: [
				{ name: 'List the groups I use', value: 'list' },
				{ name: 'Choose where backups go', value: 'use' },
				{ name: 'Create a new backup group', value: 'create' },
				{ name: 'Show an invite link and QR code', value: 'share' },
				BACK
			]
		});
		if (action === 'back') return;
		await attempt(async () => {
			const userId = await storage.requireClient().account();
			if (action === 'list') {
				const { groups, activeGroupId } = storage.groups.overview(userId);
				console.log(cliDisplayAdapter.groupsTable(groups, activeGroupId));
			} else if (action === 'use') {
				const { groups, activeGroupId } = storage.groups.overview(userId);
				console.error('Looking for groups whose titles start with TGB-...');
				const available = await storage.groups.available();
				const all = [...groups, ...available.filter((a) => !groups.some((g) => g.id === a.id))];
				if (all.length === 0) {
					console.error('No group can be used yet. Create one, or rename one in Telegram to TGB-…');
					return;
				}
				const id = await select({
					message: 'Back up to',
					default: activeGroupId ?? undefined,
					choices: all.map((group) => ({ name: `${group.title}  ${group.id}`, value: group.id }))
				});
				const group = await storage.groups.select(id);
				console.log(`Backups now go to ${group.title}.`);
			} else if (action === 'create') {
				const name = await input({
					message: 'Group name (TGB- is added in front)',
					validate: (value) => value.trim() !== '' || 'Enter a name'
				});
				const group = await storage.groups.create(name);
				console.log(`Created and chose ${group.title}.`);
			} else {
				const chosen = await chooseKnownGroup(storage, 'Which group?');
				if (!chosen) return;
				const info = await storage.groups.info(chosen.id);
				if (!info.invite) throw new Error('this account cannot share an invite to this group');
				console.log(terminalQr(info.invite));
				console.log(info.invite);
				console.log('Anyone with this link can join, then see and delete its backups.');
				for (const warning of cliDisplayAdapter.groupWarnings(info)) {
					console.log(`\nwarning: ${warning}`);
				}
			}
		});
	}
}

// Backups.

async function backupsMenu(storage: TelegramStorage): Promise<void> {
	for (;;) {
		const action = await select({
			message: 'Backups in the chosen group',
			choices: [
				{ name: 'List backups', value: 'list' },
				{ name: 'Upload a zip, or a folder of zips', value: 'upload' },
				{ name: 'Restore a backup', value: 'restore' },
				{ name: 'Delete backups', value: 'delete' },
				BACK
			]
		});
		if (action === 'back') return;
		await attempt(async () => {
			const group = await storage.groups.resolve(null);
			if (action === 'upload') {
				const path = await input({ message: 'Path', validate: existingPath });
				await uploadPaths(storage, group, [path.trim()]);
				return;
			}
			const files = await listFiles(group, null);
			if (action === 'list') {
				console.log(cliDisplayAdapter.filesTable(files));
				return;
			}
			const usable = action === 'restore' ? files.filter((file) => file.complete) : files;
			if (usable.length === 0) {
				console.log('No backups to choose from.');
				return;
			}
			const label = (file: (typeof files)[number]) =>
				`${file.name}  ${formatBytes(file.sizeBytes)}  ${cliDisplayAdapter.createdLabel(file.createdAt)}${file.complete ? '' : '  incomplete'}`;

			if (action === 'restore') {
				const id = await select({
					message: 'Restore which backup?',
					choices: usable.map((file) => ({ name: label(file), value: file.id }))
				});
				const target = resolve(
					(await input({ message: 'Save to (a file, or a folder)', default: '.' })).trim()
				);
				const path = await restoreTarget(group, id, target);
				let overwrite = false;
				if (await stat(path).catch(() => null)) {
					overwrite = await confirm({ message: `${path} exists. Overwrite it?`, default: false });
					if (!overwrite) return;
				}
				console.log(await restoreBackup(group, id, target, overwrite));
				return;
			}

			const ids = await checkbox({
				message: 'Delete which backups? (space selects)',
				choices: usable.map((file) => ({ name: label(file), value: file.id }))
			});
			if (ids.length === 0) return;
			const sure = await confirm({
				message: `Delete ${ids.length} backup(s) for every member of ${group.title}?`,
				default: false
			});
			if (!sure) return;
			for (const id of ids) {
				await group.files.delete(id);
				console.log(`deleted ${id}`);
			}
		});
	}
}

// Tracked paths.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function askClock(message: string): Promise<{ hour: number; minute: number }> {
	const text = await input({
		message,
		default: '03:00',
		validate: (value) => parseClock(value) !== null || 'Enter a time like 03:00'
	});
	return parseClock(text)!;
}

/** Ask how often, and return the cron expression. */
export async function askSchedule(current?: string): Promise<string> {
	const how = await select({
		message: current ? `How often? (now ${describeSchedule(current)})` : 'How often?',
		choices: [
			{ name: 'Every hour', value: 'hourly' },
			{ name: 'Every few hours', value: 'hours' },
			{ name: 'Every day', value: 'daily' },
			{ name: 'Every week', value: 'weekly' },
			{ name: 'Every month', value: 'monthly' },
			{ name: 'Custom cron expression', value: 'cron' }
		]
	});
	if (how === 'hourly') return '0 * * * *';
	if (how === 'hours') {
		const hours = await select({
			message: 'Every',
			choices: [2, 3, 4, 6, 8, 12].map((value) => ({ name: `${value} hours`, value }))
		});
		return `0 */${hours} * * *`;
	}
	if (how === 'daily') {
		const { hour, minute } = await askClock('At what time? (24-hour, this machine’s time)');
		return `${minute} ${hour} * * *`;
	}
	if (how === 'weekly') {
		const day = await select({
			message: 'On',
			choices: WEEKDAYS.map((name, value) => ({ name, value }))
		});
		const { hour, minute } = await askClock('At what time?');
		return `${minute} ${hour} * * ${day}`;
	}
	if (how === 'monthly') {
		const day = await input({
			message: 'On which day of the month? (1-28 runs every month)',
			default: '1',
			validate: (value) =>
				(/^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 31) ||
				'Enter a day from 1 to 31'
		});
		const { hour, minute } = await askClock('At what time?');
		return `${minute} ${hour} ${Number(day)} * *`;
	}
	const cron = await input({
		message: 'Cron expression (minute hour day-of-month month day-of-week)',
		default: current,
		validate: (value) => cronProblem(value) ?? true
	});
	return cron.trim();
}

async function chooseTracked(store: TrackedStore, message: string): Promise<string | null> {
	const entries = store.list();
	if (entries.length === 0) {
		console.log('Nothing tracked yet.');
		return null;
	}
	return select({
		message,
		choices: entries.map((entry) => ({
			name: cliDisplayAdapter.trackedChoice(entry),
			value: String(entry.id)
		}))
	});
}

async function trackedMenu(storage: TelegramStorage): Promise<void> {
	const store = trackedStore(storage);
	for (;;) {
		const action = await select({
			message: 'Scheduled backups of files on this machine',
			choices: [
				{ name: 'List tracked files and folders', value: 'list' },
				{ name: 'Mark a file or folder for backup', value: 'add' },
				{ name: 'Change how often one is backed up', value: 'schedule' },
				{ name: 'Back up now', value: 'run' },
				{ name: 'Stop backing one up', value: 'remove' },
				{ name: 'Reinstall the cron jobs', value: 'sync' },
				BACK
			]
		});
		if (action === 'back') return;
		await attempt(async () => {
			if (action === 'list') {
				console.log(cliDisplayAdapter.trackedTable(store.list()));
			} else if (action === 'add') {
				const path = await input({
					message: 'File or folder (a zip goes as it is; anything else is zipped)',
					validate: async (value) => {
						if (value.trim() === '') return 'Enter a path';
						try {
							await inspectTrackable(resolve(value.trim()), storage.dataRoot);
							return true;
						} catch (error) {
							return describeFailure(error);
						}
					}
				});
				const group = await chooseKnownGroup(storage, 'Back it up to');
				if (!group) return;
				const schedule = await askSchedule();
				const entry = await trackPath(storage, store, { path, schedule, groupId: group.id });
				console.log(
					`Tracking ${entry.path}: ${describeSchedule(entry.schedule)}, to ${entry.groupTitle}.`
				);
				if (await syncCron(store)) console.log('The cron job is installed.');
				if (await confirm({ message: 'Back it up once now?', default: true })) {
					await runAndReport(storage, store, [String(entry.id)]);
				}
			} else if (action === 'schedule') {
				const id = await chooseTracked(store, 'Which one?');
				if (!id) return;
				const entry = reschedule(store, id, await askSchedule(store.require(id).schedule));
				console.log(`${entry.path}: ${describeSchedule(entry.schedule)}.`);
				if (await syncCron(store)) console.log('The cron job is updated.');
			} else if (action === 'run') {
				const entries = store.list();
				if (entries.length === 0) {
					console.log('Nothing tracked yet.');
					return;
				}
				const id = await select({
					message: 'Back up',
					choices: [
						{ name: 'All of them', value: '' },
						...entries.map((entry) => ({
							name: cliDisplayAdapter.trackedChoice(entry),
							value: String(entry.id)
						}))
					]
				});
				await runAndReport(storage, store, id ? [id] : entries.map((entry) => String(entry.id)));
			} else if (action === 'remove') {
				const entries = store.list();
				if (entries.length === 0) {
					console.log('Nothing tracked yet.');
					return;
				}
				const ids = await checkbox({
					message: 'Stop backing up (space selects; backups already made stay)',
					choices: entries.map((entry) => ({
						name: cliDisplayAdapter.trackedChoice(entry),
						value: String(entry.id)
					}))
				});
				if (ids.length === 0) return;
				for (const id of ids) console.log(`untracked ${store.remove(id).path}`);
				await syncCron(store);
			} else if (await syncCron(store)) {
				console.log(`Crontab has ${store.list().length} tgb job(s).`);
			}
		});
	}
}

// Account.

async function accountMenu(storage: TelegramStorage): Promise<'signed-out' | void> {
	const action = await select({
		message: 'Account',
		choices: [
			{ name: 'Show status', value: 'status' },
			{ name: 'Sign out of this machine', value: 'logout' },
			BACK
		]
	});
	if (action === 'status') {
		const lines = cliDisplayAdapter.statusLines(
			await readStatus(storage),
			storage.credentials?.apiId ?? null
		);
		console.log(lines.join('\n'));
	} else if (action === 'logout') {
		const sure = await confirm({
			message: 'Sign out, and wipe the session and local indexes?',
			default: false
		});
		if (!sure) return;
		await storage.logout();
		console.log('Signed out.');
		return 'signed-out';
	}
}

/** The main menu, until the user quits. */
export async function runMenu(storage: TelegramStorage): Promise<void> {
	for (;;) {
		const status = await readStatus(storage);
		if (!status.authorized) {
			let goOn = true;
			await attempt(async () => (goOn = await signIn(storage)));
			if (!goOn) return;
			continue;
		}

		const active = status.groups.find((group) => group.id === status.activeGroupId);
		const who = status.user ? cliDisplayAdapter.userName(status.user) : 'signed in';
		console.error(`\n${who} · backups go to ${active ? active.title : 'no group yet'}`);
		if (!active) console.error('Start under Groups: create a backup group, or choose one.');

		const section = await select({
			message: 'What do you want to do?',
			choices: [
				{ name: 'Backups: list, upload, restore, delete', value: 'backups' },
				{ name: 'Scheduled backups of local files', value: 'tracked' },
				{ name: 'Groups: choose, create, invite', value: 'groups' },
				{ name: 'Account', value: 'account' },
				{ name: 'Quit', value: 'quit' }
			]
		});
		if (section === 'quit') return;
		if (section === 'backups') await backupsMenu(storage);
		else if (section === 'tracked') await trackedMenu(storage);
		else if (section === 'groups') await groupsMenu(storage);
		else await attempt(() => accountMenu(storage));
	}
}
