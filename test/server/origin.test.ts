// @vitest-environment node
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServer } from '../../src/lib/server/http/node-server';

// The guard is what's under test: no backend, and never the real data folder.
vi.mock('../../src/lib/server/telegram/instance', () => ({
	getTelegramStorage: async () => ({})
}));
import { handle } from '../../src/hooks.server';

type Headers_ = Record<string, string>;

const OWN = 'http://localhost:PORT';
const navigation = (site: string, dest = 'document') => ({
	'sec-fetch-site': site,
	'sec-fetch-mode': 'navigate',
	'sec-fetch-dest': dest
});

// [what, method, path, headers, allowed]. The header sets are what browsers send.
const cases: [string, string, string, Headers_, boolean][] = [
	['a typed address', 'GET', '/', navigation('none'), true],
	['a link from another site', 'GET', '/', navigation('cross-site'), true],
	['a link from another local port', 'GET', '/?x=1', navigation('same-site'), true],
	[
		'its module script',
		'GET',
		'/src/app.js',
		{
			origin: OWN,
			'sec-fetch-site': 'same-origin',
			'sec-fetch-mode': 'cors',
			'sec-fetch-dest': 'script'
		},
		true
	],
	[
		'its stylesheet',
		'GET',
		'/app.css',
		{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'style' },
		true
	],
	[
		'its status poll',
		'GET',
		'/api/telegram/status',
		{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
		true
	],
	[
		'its upload',
		'POST',
		'/api/telegram/files',
		{ origin: OWN, 'sec-fetch-site': 'same-origin' },
		true
	],
	[
		'its sign-out',
		'POST',
		'/api/telegram/auth/logout',
		{ origin: OWN, 'sec-fetch-site': 'same-origin' },
		true
	],
	['its restore link', 'GET', '/api/telegram/files/abc', navigation('same-origin'), true],
	['a pasted restore link', 'GET', '/api/telegram/files/abc', navigation('none'), true],
	['curl', 'POST', '/api/telegram/auth/logout', {}, true],

	[
		'sign-out from another port',
		'POST',
		'/api/telegram/auth/logout',
		{ origin: 'http://localhost:3000' },
		false
	],
	[
		'upload from another port',
		'POST',
		'/api/telegram/files',
		{ origin: 'http://localhost:3000' },
		false
	],
	[
		'the other loopback name',
		'POST',
		'/api/telegram/files',
		{ origin: 'http://127.0.0.1:PORT' },
		false
	],
	['another scheme', 'POST', '/api/telegram/files', { origin: 'https://localhost:PORT' }, false],
	['another site', 'POST', '/api/telegram/files', { origin: 'https://evil.example' }, false],
	['a sandboxed page', 'POST', '/api/telegram/files', { origin: 'null' }, false],
	[
		'same-site without Origin',
		'POST',
		'/api/telegram/auth/logout',
		{ 'sec-fetch-site': 'same-site' },
		false
	],
	[
		'cross-site without Origin',
		'POST',
		'/api/telegram/auth/logout',
		{ 'sec-fetch-site': 'cross-site' },
		false
	],
	['a form navigation', 'POST', '/', navigation('same-site'), false],
	[
		'an image tag',
		'GET',
		'/api/telegram/files/abc',
		{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
		false
	],
	['a link into the API', 'GET', '/api/telegram/files/abc', navigation('cross-site'), false],
	[
		'a disguised link into the API',
		'GET',
		'/%61pi/telegram/transfer',
		navigation('cross-site'),
		false
	],
	['a frame around the app', 'GET', '/', navigation('same-site', 'iframe'), false]
];

function forPort(headers: Headers_, port: number): Headers_ {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key, value.replace('PORT', String(port))])
	);
}

describe('only the app’s own origin, at the server', () => {
	let server: Server;
	let port: number;

	beforeEach(async () => {
		server = createAppServer((_request, response) => response.writeHead(200).end());
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	it.each(cases)('%s', async (_what, method, path, headers, allowed) => {
		const status = await new Promise<number>((resolve, reject) => {
			httpRequest(
				{
					host: '127.0.0.1',
					port,
					method,
					path,
					headers: { host: `localhost:${port}`, ...forPort(headers, port) }
				},
				(response) => {
					response.resume();
					resolve(response.statusCode!);
				}
			)
				.on('error', reject)
				.end();
		});
		expect(status).toBe(allowed ? 200 : 403);
	});
});

describe('only the app’s own origin, in the hooks', () => {
	it.each(cases)('%s', async (_what, method, path, headers, allowed) => {
		const url = new URL(path, 'https://localhost:9811');
		const event = {
			request: {
				method,
				headers: new Headers({ host: 'localhost:9811', ...forPort(headers, 9811) })
			},
			url,
			locals: {},
			getClientAddress: () => '127.0.0.1'
		} as unknown as RequestEvent;
		const response = await handle({ event, resolve: async () => new Response('ok') });
		expect(response.status).toBe(allowed ? 200 : 403);
	});
});
