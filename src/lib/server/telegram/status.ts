import type { tl } from '@mtcute/node';
import { telegramAuthAdapter } from '$adapters/classes/telegram-auth.adapter';
import type { TelegramStatus } from '$types/telegram.type';
import type { TelegramStorage } from './storage';

/** What the UI polls. */
export async function readStatus(storage: TelegramStorage): Promise<TelegramStatus> {
	const connection = storage.current;

	let signedIn = false;
	let me: tl.TypeUser | null = null;
	let userId: number | null = null;
	if (connection && (await connection.isAuthorized().catch(() => false))) {
		signedIn = true;
		me = await connection.getMe().catch(() => null);
		// The last known account, so a failed profile fetch doesn't flash the group setup.
		userId = connection.knownAccount;
	}

	const { stage, delivery } = await storage.login.progress();
	// Read after the awaits, so a switch made meanwhile shows up.
	const { groups, activeGroupId } =
		userId === null ? { groups: [], activeGroupId: null } : storage.groups.overview(userId);

	return {
		hasCredentials: storage.credentials !== null,
		connected: connection !== null,
		signedIn,
		// Groups are per account, so the app opens once the account is known.
		authorized: userId !== null,
		loginInProgress: stage,
		codeDelivery: delivery,
		user: me ? telegramAuthAdapter.userFromTl(me) : null,
		groups,
		activeGroupId
	};
}
