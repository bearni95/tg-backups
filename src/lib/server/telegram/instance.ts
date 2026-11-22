import { resolveDataDir } from '$lib/server/data-dir';
import { describeError, log } from '$lib/server/logger';
import { TelegramStorage } from './storage';

// On globalThis, so a dev-server reload can close the old client before starting
// one built from the new code: two clients must not share a session.
const INSTANCE = Symbol.for('tgb.TelegramStorage');
const holder = globalThis as { [INSTANCE]?: Promise<TelegramStorage> };

async function boot(): Promise<TelegramStorage> {
	const dataRoot = resolveDataDir();
	log.info(`data root: ${dataRoot}`);
	return TelegramStorage.init({ dataRoot });
}

// Fresh whenever this code reloads, unlike the holder.
let current: Promise<TelegramStorage> | undefined;

async function replace(previous?: Promise<TelegramStorage>): Promise<TelegramStorage> {
	if (previous) {
		try {
			await (await previous).close();
		} catch (error) {
			log.warn(`could not close the previous backend: ${describeError(error)}`);
		}
	}
	return boot();
}

export function getTelegramStorage(): Promise<TelegramStorage> {
	if (!current) {
		current = replace(holder[INSTANCE]).catch((error) => {
			current = undefined;
			delete holder[INSTANCE];
			throw error;
		});
		holder[INSTANCE] = current;
	}
	return current;
}
