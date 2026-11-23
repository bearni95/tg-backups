// Diagnostics go to stderr, so command output on stdout stays clean for pipes.
// Info lines only show with `--verbose` (or TGB_VERBOSE=1).
const PREFIX = '[tgb]';

let verbose = process.env.TGB_VERBOSE === '1';

export function setVerbose(on: boolean): void {
	verbose = on;
}

export const log = {
	info: (message: string) => {
		if (verbose) console.info(`${PREFIX} ${message}`);
	},
	warn: (message: string) => console.warn(`${PREFIX} ${message}`),
	error: (message: string) => console.error(`${PREFIX} ${message}`)
};

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
