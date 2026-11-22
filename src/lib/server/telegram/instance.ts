import { resolveDataDir } from '$lib/server/data-dir';
import { log } from '$lib/server/logger';
import { TelegramStorage } from './storage';

// On globalThis: a dev-server reload must not start a second client on one session.
const INSTANCE = Symbol.for('tgb.TelegramStorage');
const holder = globalThis as { [INSTANCE]?: Promise<TelegramStorage> };

async function boot(): Promise<TelegramStorage> {
	const dataRoot = resolveDataDir();
	log.info(`data root: ${dataRoot}`);
	return TelegramStorage.init({ dataRoot });
}

export function getTelegramStorage(): Promise<TelegramStorage> {
	holder[INSTANCE] ??= boot().catch((error) => {
		delete holder[INSTANCE];
		throw error;
	});
	return holder[INSTANCE];
}
