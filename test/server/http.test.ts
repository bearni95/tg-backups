// @vitest-environment node
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEvent } from '@sveltejs/kit';
import { getRequest, setResponse } from '@sveltejs/kit/node';
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { MultipartReader } from '../../src/lib/server/http/multipart';
import { createAppServer, parsePort } from '../../src/lib/server/http/node-server';
import type { TelegramStorage } from '../../src/lib/server/telegram/storage';
import { call, useBackend } from './support/harness';

function streamOf(bytes: Buffer, step: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + step)));
			offset += step;
		}
	});
}

async function readParts(reader: MultipartReader) {
	const parts: { name: string; filename: string | null; type: string | null; bytes: Buffer }[] = [];
	for await (const part of reader.parts()) {
		const pieces: Buffer[] = [];
		for await (const piece of part.chunks()) pieces.push(Buffer.from(piece));
		parts.push({
			name: part.name,
			filename: part.filename,
			type: part.contentType,
			bytes: Buffer.concat(pieces)
		});
	}
	return parts;
}

describe('multipart', () => {
	const tricky = Buffer.concat([
		Buffer.from('\r\n--'),
		Buffer.from([0, 255, 13, 10, 45, 45]),
		Buffer.from('\r\n--Boundar'),
		Buffer.from('\r\n')
	]);
	const body = Buffer.concat([
		Buffer.from(
			'preamble\r\n--Boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\ncòpia.zip\r\n--Boundary\r\n'
		),
		Buffer.from(
			'Content-Disposition: form-data; name="file"; filename="a;b.zip"\r\nContent-Type: application/zip\r\n\r\n'
		),
		tricky,
		Buffer.from(
			'\r\n--Boundary\r\nContent-Disposition: form-data; name="empty"\r\n\r\n\r\n--Boundary--\r\nepilogue'
		)
	]);
	const type = 'multipart/form-data; boundary=Boundary';

	it.each([1, 2, 3, 5, 7, 11, 13, 64, body.length])(
		'reads a body split every %i bytes',
		async (step) => {
			expect(await readParts(new MultipartReader(streamOf(body, step), type))).toEqual([
				{ name: 'name', filename: null, type: null, bytes: Buffer.from('còpia.zip') },
				{ name: 'file', filename: 'a;b.zip', type: 'application/zip', bytes: tricky },
				{ name: 'empty', filename: null, type: null, bytes: Buffer.alloc(0) }
			]);
		}
	);

	it('skips parts nobody reads', async () => {
		const names: string[] = [];
		for await (const part of new MultipartReader(streamOf(body, 9), type).parts())
			names.push(part.name);
		expect(names).toEqual(['name', 'file', 'empty']);
	});

	it('reads what fetch sends', async () => {
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(tricky)]), 'db.zip');
		const request = new Request('http://localhost/', { method: 'POST', body: form });
		const [part] = await readParts(
			new MultipartReader(request.body, request.headers.get('content-type'))
		);
		expect(part).toMatchObject({ name: 'file', filename: 'db.zip', bytes: tricky });
	});

	it('rejects a truncated body', async () => {
		const reader = new MultipartReader(streamOf(body.subarray(0, body.length - 30), 8), type);
		await expect(readParts(reader)).rejects.toMatchObject({ code: 'bad_request' });
	});

	it.each([null, 'application/json', 'multipart/form-data'])(
		'rejects content type %s',
		(contentType) => {
			expect(() => new MultipartReader(streamOf(body, 8), contentType)).toThrow('multipart');
		}
	);
});

describe('hooks', () => {
	const run = async (host: string, address: string, origin?: string) => {
		const headers = new Headers({ host, ...(origin && { origin }) });
		const event = {
			request: { headers },
			url: new URL('http://localhost/'),
			locals: {},
			getClientAddress: () => address
		} as unknown as RequestEvent;
		return (await handle({ event, resolve: async () => new Response('ok') })).status;
	};

	it('only answers this machine', async () => {
		expect(await run('localhost:9811', '127.0.0.1')).toBe(200);
		expect(await run('localhost:9811', '::1', 'http://localhost:9811')).toBe(200);
		expect(await run('localhost:9811', '::1', 'http://localhost:5173')).toBe(403);
		expect(await run('evil.example', '127.0.0.1')).toBe(403);
		expect(await run('localhost:9811', '192.168.1.5')).toBe(403);
		expect(await run('localhost:9811', '127.0.0.1', 'https://evil.example')).toBe(403);
	});
});

// SvelteKit's own request and response conversion, over a real socket.
describe('node server', () => {
	const backend = useBackend();
	let server: Server | undefined;

	afterEach(async () => {
		server?.closeAllConnections();
		await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
		server = undefined;
	});

	async function serve(storage: TelegramStorage): Promise<number> {
		server = createAppServer((req, res) => {
			void (async () => {
				const request = await getRequest({ request: req, base: 'http://localhost' });
				const { pathname, search } = new URL(request.url);
				const response = await call(storage, request.method, pathname + search, {
					body: request.body ?? undefined,
					headers: Object.fromEntries(request.headers)
				});
				await setResponse(res, response);
			})();
		});
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		return (server.address() as AddressInfo).port;
	}

	function zipForm(name: string, type: string, size: number) {
		const body = new FormData();
		body.append('file', new Blob([new Uint8Array(size)], { type }), name);
		return body;
	}

	it('rejects DNS rebinding and other sites', async () => {
		const port = await serve(await backend.open());
		const status = (headers: Record<string, string>) =>
			new Promise<number>((resolve, reject) => {
				httpRequest({ port, host: '127.0.0.1', path: '/api/health', headers }, (response) => {
					response.resume();
					resolve(response.statusCode!);
				})
					.on('error', reject)
					.end();
			});
		expect(await status({ host: `localhost:${port}` })).toBe(200);
		expect(await status({ host: `evil.example:${port}` })).toBe(403);
		expect(await status({ host: `localhost:${port}`, origin: 'https://evil.example' })).toBe(403);
	});

	it('has no request timeout', async () => {
		await serve(await backend.open());
		expect(server!.requestTimeout).toBe(0);
		expect(server!.headersTimeout).toBeGreaterThan(0);
	});

	it('round-trips a multi-megabyte upload', async () => {
		const port = await serve(await backend.signedIn());
		const base = `http://127.0.0.1:${port}/api/telegram/files`;
		const response = await fetch(base, {
			method: 'POST',
			body: zipForm('db.zip', 'application/zip', 4_000_000)
		});
		const { id } = await response.json();
		expect((await (await fetch(`${base}/${id}`)).arrayBuffer()).byteLength).toBe(4_000_000);
	});

	it.each([
		['signed out', false, 'db.zip', 'application/zip', 401],
		['not a zip', true, 'cover.jpg', 'image/jpeg', 415]
	])('answers a large rejected upload (%s)', async (_label, authorized, name, type, status) => {
		backend.telegram.authorized = authorized;
		const port = await serve(await backend.signedIn());
		const response = await fetch(`http://127.0.0.1:${port}/api/telegram/files`, {
			method: 'POST',
			body: zipForm(name, type, 8_000_000)
		});
		expect(response.status).toBe(status);
	});

	it('breaks the connection on a short restore', async () => {
		const storage = await backend.signedIn();
		const tgMessageId = backend.telegram.addDocument('short.zip', Buffer.alloc(5));
		const { db } = await storage.groups.resolve(null);
		db.insert({
			id: 'short',
			name: 'short.zip',
			sizeBytes: 10,
			mimeType: 'application/zip',
			tgMessageId,
			text: null,
			checksumSha256: null,
			metadata: null
		});
		db.insertPart('short', { ord: 0, tgMessageId, sizeBytes: 10, checksumSha256: null });
		const port = await serve(storage);
		await expect(
			fetch(`http://127.0.0.1:${port}/api/telegram/files/short`).then((response) =>
				response.arrayBuffer()
			)
		).rejects.toThrow();
	});

	it('parses the port', () => {
		expect(parsePort(undefined)).toBe(9811);
		expect(parsePort('')).toBe(9811);
		expect(parsePort('8080')).toBe(8080);
		for (const bad of ['abc', '70000', '-1', '1.5'])
			expect(() => parsePort(bad)).toThrow('TGB_PORT');
	});
});
