import type { tl } from '@mtcute/node';
import { log } from '$lib/server/logger';
import { telegramAuthAdapter } from '$adapters/classes/telegram-auth.adapter';
import { accessGroupInviteUrl } from '$utils/telegram/accessGroup';
import type { TelegramStatus } from '$types/telegram.type';
import { parseRequestCookie, setCookieValue } from './access-cookie';
import { accessGroupFromEnv } from './config';
import { StorageError } from './errors';
import type { TelegramStorage } from './storage';

/** The gate. `cookie` is set when a membership probe just passed. */
export async function readStatus(
	storage: TelegramStorage,
	headers: Headers
): Promise<{ status: TelegramStatus; cookie: string | null }> {
	const hasCredentials = storage.credentials !== null;
	const now = Math.floor(Date.now() / 1000);
	const connection = storage.current;

	let signedIn = false;
	let authorized = false;
	let accessDenied = false;
	let cookie: string | null = null;
	let me: tl.TypeUser | null = null;

	if (connection && (await connection.isAuthorized().catch(() => false))) {
		signedIn = true;
		me = await connection.getMe().catch(() => null);

		if (connection.accessGroup === null) {
			// No gate: signed in is enough, even if the profile fetch hiccuped.
			authorized = true;
		} else if (me) {
			const token = parseRequestCookie(headers);
			if (token !== null && storage.accessKey.verify(token, now) === me.id) {
				authorized = true;
			} else {
				try {
					if (await connection.accessAllowed(me)) {
						authorized = true;
						cookie = setCookieValue(storage.accessKey.issue(me.id, now));
					} else {
						accessDenied = true;
					}
				} catch (error) {
					// Closed but not "denied": the next poll retries.
					log.warn(
						`group membership check inconclusive, keeping gate closed: ${StorageError.from(error).message}`
					);
				}
			}
		}
	}

	const { stage, delivery } = await storage.login.progress();
	const group = accessGroupFromEnv();
	const status: TelegramStatus = {
		hasCredentials,
		connected: connection !== null,
		signedIn,
		authorized,
		accessDenied,
		accessGroupRequired: group !== null,
		accessGroupInvite: accessGroupInviteUrl(group),
		loginInProgress: stage,
		codeDelivery: delivery,
		user: me ? telegramAuthAdapter.userFromTl(me) : null
	};
	return { status, cookie };
}
