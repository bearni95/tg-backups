import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, vi } from 'vitest';
import { saveCredentials } from '../../../src/lib/server/telegram/config';
import { groupsPath, telegramDir } from '../../../src/lib/server/telegram/paths';
import { TelegramStorage } from '../../../src/lib/server/telegram/storage';
import { CHANNEL_ID, FakeTelegram, USER_ID } from './fake-telegram';

/** A temporary data root and a fake Telegram per test. Never the real `~/tg-backups`. */
export function useBackend() {
	let root = '';
	let telegram: FakeTelegram;
	let opened: TelegramStorage[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'tgb-test-'));
		telegram = new FakeTelegram();
		opened = [];
		vi.stubEnv('TELEGRAM_API_ID', '');
		vi.stubEnv('TELEGRAM_API_HASH', '');
		vi.stubEnv('TGB_DATA_DIR', root);
	});

	afterEach(async () => {
		for (const storage of opened) await storage.close().catch(() => undefined);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const open = async (dataRoot = root) => {
		const storage = await TelegramStorage.init({ dataRoot, createTransport: telegram.factory });
		opened.push(storage);
		return storage;
	};

	/** With credentials saved, so there is a client, and no group yet. */
	const withoutGroup = async (dataRoot = root) => {
		await saveCredentials(dataRoot, { apiId: 12345, apiHash: 'deadbeef' });
		return open(dataRoot);
	};

	/** With the fake's main group already chosen, as an earlier run would leave it. */
	const signedIn = async (dataRoot = root) => {
		const kind = telegram.basicGroup ? 'chat' : 'channel';
		const id = `${kind}-${CHANNEL_ID}`;
		const accessHash = telegram.basicGroup ? '0' : '8123456789012345678';
		const account = { activeGroupId: id, groups: [{ id, title: 'tgb', accessHash }] };
		mkdirSync(telegramDir(dataRoot), { recursive: true });
		writeFileSync(groupsPath(dataRoot), JSON.stringify({ v: 1, accounts: { [USER_ID]: account } }));
		return withoutGroup(dataRoot);
	};

	return {
		get root() {
			return root;
		},
		get telegram() {
			return telegram;
		},
		open,
		withoutGroup,
		signedIn,
		/** That group, opened. */
		async group(dataRoot = root) {
			return (await signedIn(dataRoot)).groups.resolve(null);
		}
	};
}

type Handler = (event: RequestEvent) => Response | Promise<Response>;

const modules = import.meta.glob<Record<string, Handler>>('../../../src/routes/api/**/+server.ts', {
	eager: true
});

const routes = Object.entries(modules)
	.map(([file, handlers]) => ({
		segments: file
			.replace(/^.*\/src\/routes/, '')
			.replace('/+server.ts', '')
			.split('/'),
		handlers
	}))
	// Static segments win, as in SvelteKit.
	.sort(
		(a, b) =>
			a.segments.filter((s) => s.startsWith('[')).length -
			b.segments.filter((s) => s.startsWith('[')).length
	);

/** Run the real route handler for a request. */
export async function call(
	storage: TelegramStorage,
	method: string,
	path: string,
	init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}
): Promise<Response> {
	const url = new URL(path, 'http://localhost:9811');
	const headers = new Headers(init.headers);
	let { body } = init;
	if (init.json !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.json);
	}

	const segments = url.pathname.split('/');
	for (const route of routes) {
		if (route.segments.length !== segments.length) continue;
		const params: Record<string, string> = {};
		const matched = route.segments.every((segment, i) => {
			if (!segment.startsWith('[')) return segment === segments[i];
			params[segment.slice(1, -1)] = decodeURIComponent(segments[i]);
			return true;
		});
		if (!matched) continue;

		const handler = route.handlers[method] ?? (method === 'HEAD' ? route.handlers.GET : undefined);
		if (!handler) return new Response(null, { status: 405 });
		const request = new Request(url, { method, headers, body, duplex: 'half' } as RequestInit);
		return handler({
			request,
			url,
			params,
			locals: { telegram: storage }
		} as unknown as RequestEvent);
	}
	throw new Error(`no route for ${path}`);
}
