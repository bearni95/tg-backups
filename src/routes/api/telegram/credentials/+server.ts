import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import { credentialsField, readJsonBody } from '$lib/server/http/body';
import { StorageError } from '$lib/server/telegram/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute((storage) => {
	if (!storage.credentials) throw StorageError.credentialsMissing();
	return jsonResponse(storage.credentials);
});

export const POST: RequestHandler = telegramRoute(async (storage, { request }) => {
	await storage.setCredentials(credentialsField(await readJsonBody(request)));
	return jsonResponse({ ok: true });
});

export const DELETE: RequestHandler = telegramRoute(async (storage) => {
	await storage.deleteCredentials();
	return jsonResponse({ ok: true });
});
