import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, vi } from 'vitest';
import { saveCredentials } from '../../../src/lib/server/telegram/config';
import { TelegramStorage } from '../../../src/lib/server/telegram/storage';
import { FakeTelegram } from './fake-telegram';

export const GROUP = 'https://t.me/+testInviteHash';

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
		vi.stubEnv('TGB_TELEGRAM_ACCESS_GROUP', GROUP);
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

	return {
		get root() {
			return root;
		},
		get telegram() {
			return telegram;
		},
		open,
		/** With credentials saved, so there is a client. */
		async signedIn(dataRoot = root) {
			await saveCredentials(dataRoot, { apiId: 12345, apiHash: 'deadbeef' });
			return open(dataRoot);
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
