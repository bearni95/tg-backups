import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { StorageError } from '$lib/server/telegram/errors';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute((storage, { params }) => {
	if (!storage.uploads.resume(params.id)) throw StorageError.notFound();
	return jsonResponse(storage.uploads.get(params.id));
});
