// @vitest-environment node
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvocationError } from '../../src/lib/server/telegram/invocation-error';
import { sessionPath } from '../../src/lib/server/telegram/paths';
import type { TelegramStorage } from '../../src/lib/server/telegram/storage';
import { call, useBackend } from './support/harness';

const backend = useBackend();
const API = '/api/telegram';

async function atPassword(via: 'qr' | 'code' = 'qr') {
	backend.telegram.authorized = false;
	const storage = await backend.signedIn();
	if (via === 'qr') {
		backend.telegram.qr = 'password';
		await call(storage, 'POST', `${API}/auth/qr`);
	} else {
		backend.telegram.passwordNeeded = true;
		await call(storage, 'POST', `${API}/auth/start`, { json: { phone: '+1' } });
		await call(storage, 'POST', `${API}/auth/code`, { json: { code: '12345' } });
	}
	return storage;
}

function submit(storage: TelegramStorage, password: string) {
	return call(storage, 'POST', `${API}/auth/password`, { json: { password } });
}

async function stage(storage: TelegramStorage) {
	return (await storage.login.progress()).stage;
}

describe('a wrong 2FA password', () => {
	it.each(['qr', 'code'] as const)('can be retyped (after %s)', async (via) => {
		const storage = await atPassword(via);
		for (const wrong of ['wrong', 'wrong again']) {
			expect((await (await submit(storage, wrong)).json()).code).toBe('invalid_password');
			expect(await stage(storage)).toBe('awaiting_password');
		}
		expect((await (await submit(storage, 'secret')).json()).outcome).toBe('authenticated');
		expect(await stage(storage)).toBeNull();
	});

	it('gets a fresh SRP challenge each time, as they are single use', async () => {
		const storage = await atPassword();
		const before = backend.telegram.count('account.getPassword');
		await submit(storage, 'wrong');
		await submit(storage, 'secret');
		expect(backend.telegram.count('account.getPassword')).toBe(before + 2);
	});

	it.each([
		InvocationError.rpc(420, 'FLOOD_WAIT_300'),
		InvocationError.rpc(400, 'SRP_ID_INVALID'),
		InvocationError.rpc(500, 'INTERNAL')
	])('keeps the login through %s', async (error) => {
		const storage = await atPassword();
		backend.telegram.intercept = (request) => {
			if (request._ === 'auth.checkPassword') throw error;
		};
		expect((await submit(storage, 'secret')).ok).toBe(false);
		expect(await stage(storage)).toBe('awaiting_password');
	});

	it.each([
		['account.getPassword', InvocationError.rpc(401, 'AUTH_KEY_UNREGISTERED')],
		['auth.checkPassword', InvocationError.rpc(500, 'AUTH_RESTART')]
	])('starts over when Telegram ended the login (%s)', async (method, error) => {
		const storage = await atPassword();
		backend.telegram.intercept = (request) => {
			if (request._ === method) throw error;
		};
		await submit(storage, 'secret');
		expect(await stage(storage)).toBeNull();
	});

	it('signs in once when submitted twice at once', async () => {
		const storage = await atPassword();
		const codes = await Promise.all([submit(storage, 'secret'), submit(storage, 'secret')]);
		expect(codes.map((response) => response.status)).toEqual([200, 400]);
	});
});

describe('starting over', () => {
	it('drops the half-finished login', async () => {
		const storage = await atPassword();
		storage.current!.session.setHomeDc(2);
		const old = storage.current;
		expect((await call(storage, 'POST', `${API}/auth/restart`)).status).toBe(200);
		expect(await stage(storage)).toBeNull();
		expect(existsSync(sessionPath(backend.root))).toBe(false);
		expect(storage.current).not.toBe(old);
		expect(backend.telegram.count('auth.logOut')).toBe(0);
	});

	it('keeps the group choice', async () => {
		const storage = await atPassword();
		await call(storage, 'POST', `${API}/auth/restart`);
		backend.telegram.authorized = true;
		expect((await storage.groups.resolve(null)).id).toMatch(/^channel-/);
	});

	it('does nothing without a login in progress', async () => {
		const storage = await backend.signedIn();
		const before = storage.current;
		expect((await call(storage, 'POST', `${API}/auth/restart`)).status).toBe(400);
		expect(storage.current).toBe(before);
	});

	it('never wipes an account that is signed in', async () => {
		const storage = await atPassword();
		backend.telegram.authorized = true;
		storage.current!.session.setHomeDc(2);
		expect((await call(storage, 'POST', `${API}/auth/restart`)).status).toBe(200);
		expect(existsSync(sessionPath(backend.root))).toBe(true);
		expect(await stage(storage)).toBeNull();
	});
});
