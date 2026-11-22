import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute(async (storage) => {
	const delivery = await storage.login.resend();
	return jsonResponse({ ok: true, stage: 'awaiting_code', delivery });
});
