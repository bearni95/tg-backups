// No imports: server.ts loads this directly under Node's type stripping.
const PREFIX = '[tgb]';

export const log = {
	info: (message: string) => console.info(`${PREFIX} ${message}`),
	warn: (message: string) => console.warn(`${PREFIX} ${message}`),
	error: (message: string) => console.error(`${PREFIX} ${message}`)
};

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
