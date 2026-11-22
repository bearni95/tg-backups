import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { uploadFromBrowser } from '$lib/server/telegram/browser-upload';
import { listFiles, uploadedEntry } from '$lib/server/telegram/catalog';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = authorizedRoute(async (storage, { url }) =>
	jsonResponse({ files: await listFiles(storage, url.searchParams.get('scope')) })
);

export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const id = await uploadFromBrowser(storage, request);
	return jsonResponse(uploadedEntry(storage, id));
});
