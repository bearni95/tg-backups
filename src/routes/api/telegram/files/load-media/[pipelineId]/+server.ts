import { groupRoute, jsonResponse } from '$lib/server/http/api';
import { loadMediaForPipeline } from '$lib/server/telegram/catalog';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = groupRoute(async (group, { params }) =>
	jsonResponse(await loadMediaForPipeline(group, params.pipelineId))
);
