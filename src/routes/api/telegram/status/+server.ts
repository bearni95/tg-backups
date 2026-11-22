import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { readStatus } from '$lib/server/telegram/status';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute(async (storage, { request }) => {
	const { status, cookie } = await readStatus(storage, request.headers);
	const response = jsonResponse(status);
	if (cookie) response.headers.set('set-cookie', cookie);
	return response;
});
