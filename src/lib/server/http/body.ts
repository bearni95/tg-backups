import { asObject, parseJson } from '$utils/json/losslessJson';
import { StorageError } from '$lib/server/telegram/errors';
import { isI32 } from '$lib/server/telegram/config';
import type { TelegramCredentials } from '$types/telegram.type';

type Fields = Record<string, unknown>;

function wrongShape(reason: string): StorageError {
	return StorageError.badRequest(reason, 422);
}

/**
 * A JSON object body. The content type is required: it is what forces a CORS
 * preflight on cross-site requests, which this API never grants.
 */
export async function readJsonBody(request: Request): Promise<Fields> {
	const type = request.headers.get('content-type') ?? '';
	if (!/^application\/(?:[^\s;/]+\+)?json\s*(?:;|$)/i.test(type)) {
		throw StorageError.badRequest('expected content-type: application/json', 415);
	}
	let parsed: unknown;
	try {
		parsed = parseJson(await request.text());
	} catch {
		// Not the parser's message: it quotes the body, passwords included.
		throw StorageError.badRequest('body is not valid JSON');
	}
	const body = asObject(parsed);
	if (!body) throw wrongShape('body must be a JSON object');
	return body;
}

export function requiredString(fields: Fields, key: string): string {
	const value = fields[key];
	if (typeof value !== 'string') throw wrongShape(`${key} must be a string`);
	return value;
}

export function optionalString(fields: Fields, key: string): string | undefined {
	const value = fields[key] ?? undefined;
	if (value !== undefined && typeof value !== 'string') throw wrongShape(`${key} must be a string`);
	return value;
}

export function optionalCount(fields: Fields, key: string): number | undefined {
	const value = fields[key] ?? undefined;
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw wrongShape(`${key} must be a whole number`);
	}
	return value;
}

export function credentialsField(value: unknown): TelegramCredentials {
	const fields = asObject(value);
	if (!fields || !isI32(fields.apiId)) throw wrongShape('apiId must be a 32-bit integer');
	return { apiId: fields.apiId, apiHash: requiredString(fields, 'apiHash') };
}
