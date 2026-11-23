// What cron runs: this node, and the bundled `tgb`.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CronTarget } from '$lib/tracked/crontab';

/**
 * The built `dist/cli.js`. From the bundle that is this very file; from source
 * (`pnpm tgb`), the build next to it, which has to exist for cron to work.
 */
export function cronTarget(): CronTarget & { built: boolean } {
	const here = fileURLToPath(import.meta.url);
	const script = here.endsWith('.js') ? here : resolve(dirname(here), '..', '..', 'dist', 'cli.js');
	return { node: process.execPath, script, built: existsSync(script) };
}

/** The note to print when cron would run a build that isn't there. */
export function missingBuildNote(script: string): string {
	return `note: cron runs ${script}, which does not exist yet. Run \`pnpm build\` in ${join(dirname(script), '..')}.`;
}
