import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { loadMediaForPipeline } from '$lib/server/telegram/catalog';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = authorizedRoute(async (storage, { params }) =>
	jsonResponse(await loadMediaForPipeline(storage, params.pipelineId))
);
