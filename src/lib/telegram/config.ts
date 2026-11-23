import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EMBEDDED_API_HASH, EMBEDDED_API_ID } from '$lib/build-info';
import { log } from '$lib/logger';
import { asObject, parseJson } from '$utils/json/losslessJson';
import type { TelegramCredentials } from '$types/telegram.type';
import type { StoredCredentials } from '$types/telegram-engine.type';
import { StorageError } from './errors';
import { credentialsPath } from './paths';

export function isI32(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31
	);
}

export async function loadCredentials(dataRoot: string): Promise<TelegramCredentials | null> {
	let text: string;
	try {
		text = await readFile(credentialsPath(dataRoot), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw StorageError.from(error);
	}

	let stored: Record<string, unknown> | null;
	try {
		stored = asObject(parseJson(text));
	} catch {
		// Not the parser's message: it quotes the file, api_hash included.
		throw StorageError.internal('json: credentials.json is not valid JSON');
	}
	if (!stored || !isI32(stored.api_id) || typeof stored.api_hash !== 'string') {
		throw StorageError.internal('json: credentials.json needs api_id and api_hash');
	}
	return { apiId: stored.api_id, apiHash: stored.api_hash };
}

export async function saveCredentials(
	dataRoot: string,
	{ apiId, apiHash }: TelegramCredentials
): Promise<void> {
	const path = credentialsPath(dataRoot);
	const stored: StoredCredentials = { api_id: apiId, api_hash: apiHash };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(stored, null, 2));
}

export async function clearCredentials(dataRoot: string): Promise<void> {
	await rm(credentialsPath(dataRoot), { force: true });
}

function parseCredentials(rawId: string, rawHash: string): TelegramCredentials | null {
	const id = rawId.trim();
	const apiHash = rawHash.trim();
	if (!/^\+?[0-9]+$/.test(id) || apiHash === '') return null;
	const apiId = Number(id);
	return isI32(apiId) && apiId > 0 ? { apiId, apiHash } : null;
}

export function credentialsFromEnv(
	env: Record<string, string | undefined> = process.env
): TelegramCredentials | null {
	const credentials = parseCredentials(env.TELEGRAM_API_ID ?? '', env.TELEGRAM_API_HASH ?? '');
	if (credentials) {
		log.info(`loaded Telegram credentials from environment (api_id=${credentials.apiId})`);
	}
	return credentials;
}

export function credentialsFromBuild(
	apiId: string = EMBEDDED_API_ID,
	apiHash: string = EMBEDDED_API_HASH
): TelegramCredentials | null {
	const credentials = parseCredentials(apiId, apiHash);
	if (credentials) {
		log.info(`loaded Telegram credentials from the build (api_id=${credentials.apiId})`);
	}
	return credentials;
}
