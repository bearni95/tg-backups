import type { RequestEvent } from '@sveltejs/kit';
import { describeError, log } from '$lib/server/logger';
import type { BackupGroup } from '$lib/server/telegram/backup-group';
import { StorageError } from '$lib/server/telegram/errors';
import type { TelegramStorage } from '$lib/server/telegram/storage';

/** Not Kit's `json`, which can't be given exact 64-bit integers. */
export function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

export function errorResponse(error: unknown): Response {
	const mapped = StorageError.from(error);
	if (mapped.status >= 500) log.error(mapped.message);
	return jsonResponse(mapped.toJSON(), mapped.status);
}

/**
 * A body left unread stalls its socket, and browsers don't read the response
 * until they finish sending. So a rejected request is still read to the end.
 */
function discardBody({ body }: Request): void {
	if (!body || body.locked) return;
	body
		.pipeTo(new WritableStream())
		.catch((error) => log.info(`request body discarded: ${describeError(error)}`));
}

/** A Telegram route: gets the storage, and turns throws into `{ error, code }`. */
export function telegramRoute<Event extends RequestEvent>(
	handler: (storage: TelegramStorage, event: Event) => Response | Promise<Response>
): (event: Event) => Promise<Response> {
	return async (event) => {
		try {
			return await handler(event.locals.telegram, event);
		} catch (error) {
			discardBody(event.request);
			return errorResponse(error);
		}
	};
}

/** A route that needs a signed-in account. */
export function authorizedRoute<Event extends RequestEvent>(
	handler: (storage: TelegramStorage, event: Event) => Response | Promise<Response>
): (event: Event) => Promise<Response> {
	return telegramRoute<Event>(async (storage, event) => {
		await storage.requireAuthorized();
		return handler(storage, event);
	});
}

/**
 * A route working on one group. Callers name it with `?group=`, so a tab left
 * open on another group can't act on the wrong one.
 */
export function groupRoute<Event extends RequestEvent>(
	handler: (
		group: BackupGroup,
		event: Event,
		storage: TelegramStorage
	) => Response | Promise<Response>
): (event: Event) => Promise<Response> {
	return authorizedRoute<Event>(async (storage, event) => {
		const group = await storage.groups.resolve(event.url.searchParams.get('group'));
		return handler(group, event, storage);
	});
}
