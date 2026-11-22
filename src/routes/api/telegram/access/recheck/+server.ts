import { telegramRoute } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = telegramRoute((storage) => {
	storage.current?.recheckAccess();
	return new Response(null, { status: 204 });
});
