// Used by server.ts and vite.config.ts under plain Node, hence the `.ts` import.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hasLocalHeaders, isLoopbackAddress } from '../../../utils/http/loopback.ts';

export const DEFAULT_PORT = 9811;

type Next = () => void;
type Middleware = (request: IncomingMessage, response: ServerResponse, next: Next) => void;

/** Covers static files and source modules too, which SvelteKit hooks never see. */
export const localOnly: Middleware = (request, response, next) => {
	if (
		isLoopbackAddress(request.socket.remoteAddress) &&
		hasLocalHeaders(request.headers.host, request.headers.origin)
	) {
		return next();
	}
	response.writeHead(403).end();
};

/**
 * Node cuts any request still arriving after 5 minutes, which is every large
 * browser upload. 0 turns that off; headers keep their own timeout.
 */
export function allowLongRequests(server: object): void {
	Object.assign(server, { requestTimeout: 0 });
}

export function createAppServer(handler: Middleware): Server {
	const server = createServer((request, response) => {
		localOnly(request, response, () => {
			handler(request, response, () => response.writeHead(404).end());
		});
	});
	allowLongRequests(server);
	return server;
}

export function parsePort(value: string | undefined): number {
	if (!value) return DEFAULT_PORT;
	const port = Number(value);
	if (!/^\d+$/.test(value) || port > 65535) throw new Error('TGB_PORT is not a port');
	return port;
}
