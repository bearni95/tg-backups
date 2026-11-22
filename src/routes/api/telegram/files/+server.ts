import { groupRoute, jsonResponse } from '$lib/server/http/api';
import { uploadFromBrowser } from '$lib/server/telegram/browser-upload';
import { listFiles, uploadedEntry } from '$lib/server/telegram/catalog';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = groupRoute(async (group, { url }) =>
	jsonResponse({ files: await listFiles(group, url.searchParams.get('scope')) })
);

export const POST: RequestHandler = groupRoute(async (group, { request }, storage) => {
	const id = await uploadFromBrowser(storage, group, request);
	return jsonResponse(uploadedEntry(group, id));
});
