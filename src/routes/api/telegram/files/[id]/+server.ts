import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { restoreResponse } from '$lib/server/telegram/restore';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = authorizedRoute((storage, { params, request }) =>
	restoreResponse(storage, params.id, request)
);

export const DELETE: RequestHandler = authorizedRoute(async (storage, { params }) => {
	await storage.files.delete(params.id);
	return jsonResponse({ ok: true });
});
