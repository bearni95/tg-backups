import { jsonResponse } from '$lib/server/http/api';
import { APP_VERSION } from '$lib/server/build-info';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => jsonResponse({ status: 'ok', version: APP_VERSION });
