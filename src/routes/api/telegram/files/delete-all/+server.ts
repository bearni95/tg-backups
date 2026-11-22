import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

// Deletes every message in the group. The caller is responsible for confirming.
export const POST: RequestHandler = authorizedRoute(async (storage) =>
	jsonResponse({ ok: true, deleted: await storage.files.deleteAll() })
);
