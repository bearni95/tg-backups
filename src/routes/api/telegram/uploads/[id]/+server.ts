import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { StorageError } from '$lib/server/telegram/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute((storage, { params }) => {
	const snapshot = storage.uploads.get(params.id);
	if (!snapshot) throw StorageError.notFound();
	return jsonResponse(snapshot);
});

export const DELETE: RequestHandler = telegramRoute((storage, { params }) => {
	if (!storage.uploads.cancel(params.id)) throw StorageError.notFound();
	return jsonResponse({ ok: true });
});
