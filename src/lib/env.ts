import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDotenv } from '$utils/env/parseDotenv';
import { describeError, log } from './logger';

function findDotenv(directory: string): string | null {
	const candidate = join(directory, '.env');
	if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
	const parent = dirname(directory);
	return parent === directory ? null : findDotenv(parent);
}

/** Load the nearest .env, searching upwards. The real environment always wins. */
export function loadDotenv(
	directory: string = process.cwd(),
	env: Record<string, string | undefined> = process.env
): void {
	try {
		const path = findDotenv(directory);
		if (!path) return;
		const { values, error } = parseDotenv(readFileSync(path, 'utf8'), env);
		for (const [key, value] of values) env[key] ??= value;
		if (error) log.warn(`failed to load all of ${path}: ${error}`);
	} catch (error) {
		log.warn(`failed to load .env: ${describeError(error)}`);
	}
}
