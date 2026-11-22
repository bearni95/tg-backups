import { authorizedRoute, jsonResponse } from '$lib/server/http/api';
import { optionalString, readJsonBody, requiredString } from '$lib/server/http/body';
import { uploadedEntry } from '$lib/server/telegram/catalog';
import { uploadFromPath } from '$lib/server/telegram/local-paths';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const body = await readJsonBody(request);
	const id = await uploadFromPath(storage, {
		path: requiredString(body, 'path'),
		name: optionalString(body, 'name'),
		mimeType: optionalString(body, 'mimeType'),
		metadata: body.metadata ?? undefined,
		text: optionalString(body, 'text')
	});
	return jsonResponse(uploadedEntry(storage, id));
});
