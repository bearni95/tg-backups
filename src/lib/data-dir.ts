import { homedir } from 'node:os';
import { join } from 'node:path';

const SUBDIR = 'tg-backups';

/**
 * Everything the app writes lives under one root: `TGB_DATA_DIR`, else
 * `~/tg-backups`, else `./tg-backups` on hosts without a home directory.
 */
export function resolveDataDir(
	override: string | undefined = process.env.TGB_DATA_DIR,
	home: () => string = homedir
): string {
	if (override) return override;
	try {
		const directory = home();
		if (directory) return join(directory, SUBDIR);
	} catch {
		// No home directory: fall through to the working directory.
	}
	return SUBDIR;
}
