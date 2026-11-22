import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { readJsonBody, requiredString } from '$lib/server/http/body';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute(async (storage, { request }) => {
	const password = requiredString(await readJsonBody(request), 'password');
	return jsonResponse(await storage.login.submitPassword(password));
});
