import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { readJsonBody, requiredString } from '$lib/server/http/body';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute(async (storage, { request }) => {
	const delivery = await storage.login.start(requiredString(await readJsonBody(request), 'phone'));
	return jsonResponse({ ok: true, stage: 'awaiting_code', delivery });
});
