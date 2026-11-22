import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = authorizedRoute(async (storage, { params }) =>
	jsonResponse(await storage.groups.info(params.id))
);
