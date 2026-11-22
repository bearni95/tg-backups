import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute(async (storage) =>
	jsonResponse(await storage.login.qrStep())
);
