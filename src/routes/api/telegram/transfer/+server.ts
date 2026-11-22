import { jsonResponse, telegramRoute } from '$lib/server/http/api';
import {
	credentialsField,
	optionalCount,
	optionalString,
	readJsonBody
} from '$lib/server/http/body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = telegramRoute(async (storage, { url }) =>
	jsonResponse(await storage.exportTransfer(url.searchParams.get('scope') ?? 'full'))
);

export const POST: RequestHandler = telegramRoute(async (storage, { request }) => {
	const body = await readJsonBody(request);
	await storage.importTransfer({
		v: optionalCount(body, 'v'),
		kind: optionalString(body, 'kind'),
		credentials: body.credentials == null ? undefined : credentialsField(body.credentials),
		session: body.session ?? undefined
	});
	return jsonResponse({ ok: true });
});
