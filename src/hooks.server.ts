import type { Handle, RequestEvent, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { loadDotenv } from '$lib/server/env';
import { errorResponse } from '$lib/server/http/api';
import { getTelegramStorage } from '$lib/server/telegram/instance';
import { hasLocalHeaders, isLoopbackAddress } from '$utils/http/loopback';

export const init: ServerInit = async () => {
	if (building) return;
	loadDotenv();
	await getTelegramStorage();
};

function isLocal(event: RequestEvent): boolean {
	const { headers } = event.request;
	if (!hasLocalHeaders(headers.get('host'), headers.get('origin'))) return false;
	try {
		return isLoopbackAddress(event.getClientAddress());
	} catch {
		return false;
	}
}

// server.ts guards too. This also covers `vite preview` and a bare adapter build.
export const handle: Handle = async ({ event, resolve }) => {
	if (!building) {
		if (!isLocal(event)) return new Response(null, { status: 403 });
		if (event.url.pathname.startsWith('/api/telegram')) {
			try {
				event.locals.telegram = await getTelegramStorage();
			} catch (error) {
				return errorResponse(error);
			}
		}
	}
	return resolve(event);
};
