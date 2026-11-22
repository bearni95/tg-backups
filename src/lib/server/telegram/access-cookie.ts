// A signed cookie that lets /status skip the membership probe for an hour. It is
// bound to the account's id and only skips that probe: the MTProto session is
// still the real auth boundary.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeError, log } from '$lib/server/logger';
import { accessKeyPath } from './paths';

export const COOKIE_NAME = 'tgb_access';
export const TTL_SECONDS = 3600;

const KEY_BYTES = 32;

function parseInteger(text: string): number | null {
	if (!/^[+-]?[0-9]+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : null;
}

export class AccessKey {
	constructor(private readonly key: Uint8Array) {}

	static loadOrCreate(dataRoot: string): AccessKey {
		const path = accessKeyPath(dataRoot);
		try {
			const stored = readFileSync(path);
			if (stored.length === KEY_BYTES) return new AccessKey(stored);
		} catch {
			// Missing or unreadable: make a new one.
		}

		const key = randomBytes(KEY_BYTES);
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, key, { mode: 0o600 });
			chmodSync(path, 0o600);
		} catch (error) {
			log.warn(`could not persist access-cookie key at ${path}: ${describeError(error)}`);
		}
		return new AccessKey(key);
	}

	issue(userId: number, now: number): string {
		const payload = `${userId}.${now + TTL_SECONDS}`;
		return `${payload}.${this.sign(payload).toString('hex')}`;
	}

	/** The bound user id, when the signature holds and the token hasn't expired. */
	verify(token: string, now: number): number | null {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [user, expiry, mac] = parts;

		const userId = parseInteger(user);
		const expires = parseInteger(expiry);
		if (userId === null || expires === null || expires <= now) return null;
		if (!/^(?:[0-9a-fA-F]{2})+$/.test(mac)) return null;

		const provided = Buffer.from(mac, 'hex');
		const expected = this.sign(`${userId}.${expires}`);
		if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
		return userId;
	}

	private sign(payload: string): Buffer {
		return createHmac('sha256', this.key).update(payload).digest();
	}
}

/** No `Secure`: the app is served over loopback http. */
export function setCookieValue(token: string): string {
	return `${COOKIE_NAME}=${token}; Max-Age=${TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`;
}

export function parseRequestCookie(headers: Headers): string | null {
	for (const pair of headers.get('cookie')?.split(';') ?? []) {
		const trimmed = pair.trim();
		if (trimmed.startsWith(`${COOKIE_NAME}=`)) return trimmed.slice(COOKIE_NAME.length + 1);
	}
	return null;
}
