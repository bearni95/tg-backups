// The transfer file `tgb transfer export` writes and `tgb transfer import` reads.
import { asObject, parseJson } from '$utils/json/losslessJson';
import type { TelegramCredentials } from '$types/telegram.type';
import { isI32 } from './config';
import { StorageError } from './errors';
import type { TransferImport } from './storage';

type Fields = Record<string, unknown>;

function wrongShape(reason: string): StorageError {
	return StorageError.badRequest(reason);
}

function optionalString(fields: Fields, key: string): string | undefined {
	const value = fields[key] ?? undefined;
	if (value !== undefined && typeof value !== 'string') throw wrongShape(`${key} must be a string`);
	return value;
}

function optionalCount(fields: Fields, key: string): number | undefined {
	const value = fields[key] ?? undefined;
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw wrongShape(`${key} must be a whole number`);
	}
	return value;
}

function credentialsField(value: unknown): TelegramCredentials {
	const fields = asObject(value);
	if (!fields || !isI32(fields.apiId)) throw wrongShape('apiId must be a 32-bit integer');
	if (typeof fields.apiHash !== 'string') throw wrongShape('apiHash must be a string');
	return { apiId: fields.apiId, apiHash: fields.apiHash };
}

/** Lossless, since the session holds 64-bit access hashes. */
export function parseTransfer(text: string): TransferImport {
	let parsed: unknown;
	try {
		parsed = parseJson(text);
	} catch {
		// Not the parser's message: it quotes the file, session included.
		throw StorageError.badRequest('transfer file is not valid JSON');
	}
	const body = asObject(parsed);
	if (!body) throw wrongShape('transfer file must hold a JSON object');
	return {
		v: optionalCount(body, 'v'),
		kind: optionalString(body, 'kind'),
		credentials: body.credentials == null ? undefined : credentialsField(body.credentials),
		session: body.session ?? undefined
	};
}
