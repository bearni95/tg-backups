// What Telegram is asked about groups: create one, list the candidates, inspect one.
import { Long, type tl } from '@mtcute/node';
import { log } from '$lib/server/logger';
import { telegramGroupAdapter } from '$adapters/classes/telegram-group.adapter';
import { telegramPeerAdapter } from '$adapters/classes/telegram-peer.adapter';
import type { GroupDetails, PeerRef, SavedGroup } from '$types/telegram-server.type';
import type { Connection } from './connection';
import { StorageError } from './errors';
import { isRpc } from './invocation-error';

export const MAX_TITLE_LENGTH = 128;

const ABOUT = 'Backups made with tg-backups. Deleting messages here deletes backups.';
const CREATE_TIMEOUT_MS = 60_000;
const DIALOGS_PER_CALL = 100;
const MAIN_FOLDER = 0;
const ARCHIVE_FOLDER = 1;

const CREATE_REFUSALS: Record<string, string> = {
	CHANNELS_TOO_MUCH: 'this account is in too many groups and channels; leave one and try again',
	USER_RESTRICTED: 'Telegram does not allow this account to create groups',
	CHAT_TITLE_EMPTY: 'group name is required'
};

const NO_ACCESS = [
	'CHANNEL_PRIVATE',
	'CHANNEL_INVALID',
	'CHAT_ID_INVALID',
	'PEER_ID_INVALID',
	'CHAT_FORBIDDEN'
];

/** A private supergroup, set up so backups stay and new members can see them. */
export async function createGroup(connection: Connection, title: string): Promise<SavedGroup> {
	let updates: tl.TypeUpdates;
	try {
		// No automatic retry: one after a timeout would make a second group.
		updates = await connection.invokeOnce(
			{ _: 'channels.createChannel', megagroup: true, title, about: ABOUT },
			{ timeoutMs: CREATE_TIMEOUT_MS }
		);
	} catch (error) {
		for (const [name, reason] of Object.entries(CREATE_REFUSALS)) {
			if (isRpc(error, name)) throw StorageError.badRequest(reason);
		}
		throw error;
	}

	const chats = 'chats' in updates ? updates.chats : [];
	const created = chats.find((chat) => chat._ === 'channel');
	const group = created ? telegramGroupAdapter.fromChat(created) : null;
	if (!created || !group) {
		throw StorageError.telegram(
			'the group was created but Telegram did not return it; pick it under "Use an existing group"'
		);
	}
	return group;
}

/**
 * Telegram may hide history from new members, and a new chat can inherit the
 * account's auto-delete timer, which would delete the backups. Best effort:
 * `inspectGroup` reports whatever is still wrong.
 */
export async function configureNewGroup(connection: Connection, peer: PeerRef): Promise<void> {
	const attempt = async (what: string, task: () => Promise<unknown>) => {
		try {
			await task();
		} catch (error) {
			if (isRpc(error, 'CHAT_NOT_MODIFIED')) return;
			log.warn(`new group: could not ${what}: ${StorageError.from(error).message}`);
		}
	};

	await attempt('show history to new members', () =>
		connection.invoke({
			_: 'channels.togglePreHistoryHidden',
			channel: telegramPeerAdapter.toInputChannel(peer),
			enabled: false
		})
	);
	await attempt('turn auto-delete off', () =>
		connection.invoke({
			_: 'messages.setHistoryTTL',
			peer: telegramPeerAdapter.toInputPeer(peer),
			period: 0
		})
	);
}

/** Groups and channels the account can post files in, archived ones included. */
export async function listCandidateGroups(connection: Connection): Promise<SavedGroup[]> {
	const found = new Map<string, SavedGroup>();
	for (const folderId of [MAIN_FOLDER, ARCHIVE_FOLDER]) {
		for await (const chat of iterateDialogChats(connection, folderId)) {
			const group = telegramGroupAdapter.fromChat(chat);
			if (group) found.set(group.id, group);
		}
	}
	return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function* iterateDialogChats(
	connection: Connection,
	folderId: number
): AsyncGenerator<tl.TypeChat> {
	let offsetDate = 0;
	let offsetId = 0;
	let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' };
	let excludePinned = false;
	let lastPeer = '';

	for (;;) {
		const page = await connection.invoke({
			_: 'messages.getDialogs',
			folderId,
			excludePinned,
			offsetDate,
			offsetId,
			offsetPeer,
			limit: DIALOGS_PER_CALL,
			hash: Long.ZERO
		});
		if (page._ === 'messages.dialogsNotModified') return;

		// `chats` also holds the origins of forwards, so only take chats with a dialog.
		const dialogs = page.dialogs.filter((dialog): dialog is tl.RawDialog => dialog._ === 'dialog');
		const refs = dialogs.map((dialog) =>
			telegramPeerAdapter.fromPeer(dialog.peer, page.users, page.chats)
		);
		for (const ref of refs) {
			if (ref.kind === 'user') continue;
			const chat = page.chats.find(
				(candidate) =>
					candidate.id === ref.id && telegramPeerAdapter.fromChat(candidate).kind === ref.kind
			);
			if (chat) yield chat;
		}

		if (page._ === 'messages.dialogs' || page.dialogs.length < DIALOGS_PER_CALL) return;
		const last = refs.at(-1);
		if (!last) return;
		// An offset that stops moving would loop for ever.
		const lastId = telegramGroupAdapter.idFromPeer(last);
		if (lastId === lastPeer) return;
		lastPeer = lastId;

		excludePinned = true;
		for (let i = dialogs.length - 1; i >= 0; i--) {
			const top = page.messages.find(
				(message) =>
					message.id === dialogs[i].topMessage &&
					message.peerId !== undefined &&
					telegramPeerAdapter.matches(message.peerId, refs[i])
			);
			if (!top) continue;
			offsetId = top.id;
			offsetDate = top._ === 'messageEmpty' ? 0 : top.date;
			break;
		}
		offsetPeer = telegramPeerAdapter.toInputPeer(last);
	}
}

/** The group as it is now. Throws `group_unavailable` when the account isn't in it. */
export async function inspectGroup(
	connection: Connection,
	peer: PeerRef,
	userId: number
): Promise<GroupDetails> {
	let result: tl.messages.TypeChatFull;
	try {
		result =
			peer.kind === 'channel'
				? await connection.invoke({
						_: 'channels.getFullChannel',
						channel: telegramPeerAdapter.toInputChannel(peer)
					})
				: await connection.invoke({ _: 'messages.getFullChat', chatId: peer.id });
	} catch (error) {
		if (NO_ACCESS.some((name) => isRpc(error, name))) throw StorageError.groupUnavailable();
		throw error;
	}

	const { fullChat, chats } = result;
	if (fullChat._ !== 'channelFull' && fullChat._ !== 'chatFull') {
		throw StorageError.groupUnavailable();
	}
	const chat = chats.find((candidate) => candidate.id === peer.id);
	if (!chat || (chat._ !== 'channel' && chat._ !== 'chat') || chat.left) {
		throw StorageError.groupUnavailable();
	}
	if (chat._ === 'chat') {
		if (chat.deactivated || chat.migratedTo) throw StorageError.groupUnavailable();
		const members = fullChat._ === 'chatFull' ? fullChat.participants : null;
		if (
			members?._ === 'chatParticipants' &&
			!members.participants.some((member) => member.userId === userId)
		) {
			throw StorageError.groupUnavailable();
		}
	}

	const invite = fullChat.exportedInvite;
	return {
		title: chat.title,
		invite:
			invite?._ === 'chatInviteExported' && !invite.revoked
				? invite.link
				: chat._ === 'channel' && chat.username
					? `https://t.me/${chat.username}`
					: null,
		autoDeleteSeconds: fullChat.ttlPeriod || null,
		// Basic groups always hide older messages from new members.
		historyHidden: fullChat._ === 'channelFull' ? !!fullChat.hiddenPrehistory : true
	};
}
