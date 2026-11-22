import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { readStatus } from '$lib/server/telegram/status';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute(async (storage) =>
	jsonResponse(await readStatus(storage))
);
