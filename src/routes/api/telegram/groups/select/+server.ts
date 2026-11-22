import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { readJsonBody, requiredString } from '$lib/server/http/body';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const id = requiredString(await readJsonBody(request), 'id');
	return jsonResponse({ group: await storage.groups.select(id) });
});
