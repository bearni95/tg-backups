import { authorizedRoute, jsonResponse, telegramRoute } from '$lib/server/http/api';
import { optionalString, readJsonBody, requiredString } from '$lib/server/http/body';
import { startUpload } from '$lib/server/telegram/local-paths';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute((storage) =>
	jsonResponse({ uploads: storage.uploads.list() })
);

export const POST: RequestHandler = authorizedRoute(async (storage, { request }) => {
	const body = await readJsonBody(request);
	const snapshot = await startUpload(storage, {
		path: requiredString(body, 'path'),
		name: optionalString(body, 'name'),
		mimeType: optionalString(body, 'mimeType'),
		metadata: body.metadata ?? undefined,
		text: optionalString(body, 'text'),
		refId: optionalString(body, 'refId') ?? optionalString(body, 'ref')
	});
	return jsonResponse({ uploadId: snapshot.uploadId, snapshot });
});
