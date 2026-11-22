import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { readJsonBody, requiredString } from '$lib/server/http/body';
import type { RequestHandler } from './$types';

// Deletes every message in the group, so it never defaults to the selected one.
// The JSON body also stops other sites: it needs a preflight nobody grants.
export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const groupId = requiredString(await readJsonBody(request), 'groupId');
	const group = await storage.groups.resolve(groupId);
	return jsonResponse({ ok: true, deleted: await group.files.deleteAll() });
});
