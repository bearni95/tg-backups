import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { readJsonBody, requiredString } from '$lib/server/http/body';
import type { RequestHandler } from './$types';

// Creates a real group on the signed-in account.
export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const title = requiredString(await readJsonBody(request), 'title');
	return jsonResponse({ group: await storage.groups.create(title) });
});
