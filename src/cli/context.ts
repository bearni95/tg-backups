// What every command shares: the engine, the chosen group, and error output.
import { resolveDataDir } from '$lib/data-dir';
import { describeError, log } from '$lib/logger';
import type { BackupGroup } from '$lib/telegram/backup-group';
import { StorageError, type ErrorCode } from '$lib/telegram/errors';
import { TelegramStorage } from '$lib/telegram/storage';
import type { TransportFactory } from '$lib/telegram/transport';

/** What to do next, for errors with an obvious fix. */
const HINTS: Partial<Record<ErrorCode, string>> = {
	credentials_missing:
		'Run `tgb credentials set` with an API id and hash from https://my.telegram.org/apps.',
	not_authenticated: 'Run `tgb login`.',
	group_required:
		'Run `tgb groups create <name>`, or `tgb groups available` then `tgb groups use <id>`.',
	group_not_found: 'Run `tgb groups list` to see the groups this account uses.',
	no_login_in_progress: 'Run `tgb login`.'
};

/** Set by tests, so commands run against a fake Telegram. */
let transportOverride: TransportFactory | undefined;

export function useTransport(factory: TransportFactory | undefined): void {
	transportOverride = factory;
}

export function openStorage(): Promise<TelegramStorage> {
	return TelegramStorage.init({
		dataRoot: resolveDataDir(),
		createTransport: transportOverride
	});
}

/** Raised by prompts when the user presses Ctrl+C. */
function isPromptExit(error: unknown): boolean {
	return error instanceof Error && error.name === 'ExitPromptError';
}

/** A message for the terminal, with the fix when there is an obvious one. */
export function describeFailure(error: unknown): string {
	const mapped = StorageError.from(error);
	const hint = HINTS[mapped.code];
	return hint ? `${mapped.message}\n${hint}` : mapped.message;
}

/**
 * Run a command with the engine open, and always close it: the session is
 * saved on close, and an open client keeps the process alive.
 */
export async function withStorage(
	action: (storage: TelegramStorage) => Promise<void>
): Promise<void> {
	let storage: TelegramStorage | null = null;
	try {
		storage = await openStorage();
		await action(storage);
	} catch (error) {
		if (isPromptExit(error)) {
			process.exitCode = 130;
		} else {
			console.error(`error: ${describeFailure(error)}`);
			process.exitCode = process.exitCode || 1;
		}
	} finally {
		try {
			await storage?.close();
		} catch (error) {
			log.warn(`could not close the client: ${describeError(error)}`);
		}
	}
}

/**
 * A group the account uses, named by id or exact title. Without a name, the
 * selected one. Titles can repeat, so an ambiguous title is refused.
 */
export async function resolveGroup(storage: TelegramStorage, name?: string): Promise<BackupGroup> {
	await storage.requireAuthorized();
	if (name === undefined) return storage.groups.resolve(null);
	const { groups } = storage.groups.overview(await storage.requireClient().account());
	if (groups.some((group) => group.id === name)) return storage.groups.resolve(name);

	const titled = groups.filter((group) => group.title === name);
	if (titled.length > 1) {
		throw StorageError.badRequest(`several groups are titled ${name}: name one by id`);
	}
	return storage.groups.resolve(titled[0]?.id ?? name);
}

export function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}
