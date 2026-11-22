import { groupRoute, jsonResponse } from '$lib/server/http/api';
import { restoreResponse } from '$lib/server/telegram/restore';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = groupRoute((group, { params, request }) =>
	restoreResponse(group, params.id, request)
);

export const DELETE: RequestHandler = groupRoute(async (group, { params }) => {
	await group.files.delete(params.id);
	return jsonResponse({ ok: true });
});
