// The group behind TGB_TELEGRAM_ACCESS_GROUP is the login gate and the storage.
import { Long, type tl } from '@mtcute/node';
import { log } from '$lib/server/logger';
import { telegramPeerAdapter } from '$adapters/classes/telegram-peer.adapter';
import {
	parseGroupIdCandidates,
	parseGroupUsername,
	parseInviteHash
} from '$utils/telegram/accessGroup';
import type { PeerRef } from '$types/telegram-server.type';
import type { Connection } from './connection';
import { StorageError } from './errors';
import { InvocationError, isRpc } from './invocation-error';

const DIALOGS_PER_CALL = 100;

async function resolveUsername(connection: Connection, username: string): Promise<PeerRef | null> {
	try {
		const { peer, users, chats } = await connection.invoke({
			_: 'contacts.resolveUsername',
			username
		});
		return telegramPeerAdapter.fromResolved(peer, users, chats);
	} catch (error) {
		if (isRpc(error, 'USERNAME_NOT_OCCUPIED')) return null;
		throw error;
	}
}

/** A member always has the group among their dialogs, so a miss means "not a member". */
async function findInDialogs(connection: Connection, ids: number[]): Promise<PeerRef | null> {
	let offsetDate = 0;
	let offsetId = 0;
	let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' };
	let excludePinned = false;

	for (;;) {
		const page = await connection.invoke({
			_: 'messages.getDialogs',
			excludePinned,
			offsetDate,
			offsetId,
			offsetPeer,
			limit: DIALOGS_PER_CALL,
			hash: Long.ZERO
		});
		if (page._ === 'messages.dialogsNotModified') return null;

		// Communities have no peer, so they can't be the group.
		const dialogs = page.dialogs.filter(
			(dialog): dialog is tl.RawDialog | tl.RawDialogFolder => 'peer' in dialog
		);
		const refs = dialogs.map((dialog) =>
			telegramPeerAdapter.fromPeer(dialog.peer, page.users, page.chats)
		);
		const match = refs.find((ref) => ids.includes(ref.id));
		if (match) return match;
		if (page._ === 'messages.dialogs' || page.dialogs.length < DIALOGS_PER_CALL) return null;
		if (refs.length === 0) return null;

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
		offsetPeer = telegramPeerAdapter.toInputPeer(refs[refs.length - 1]);
	}
}

export async function resolveGroupPeer(
	connection: Connection,
	spec: string
): Promise<PeerRef | null> {
	const hash = parseInviteHash(spec);
	if (hash) {
		try {
			const invite = await connection.invoke({ _: 'messages.checkChatInvite', hash });
			return invite._ === 'chatInviteAlready' ? telegramPeerAdapter.fromChat(invite.chat) : null;
		} catch (error) {
			const mapped = StorageError.from(error);
			// Keep signed-out and flood errors as they are.
			if (mapped.code !== 'telegram_error' || !InvocationError.is(error)) throw mapped;
			throw StorageError.telegram(
				`checkChatInvite storage-peer resolution failed: ${error.message}`
			);
		}
	}

	const username = parseGroupUsername(spec);
	if (username !== null) return resolveUsername(connection, username);

	const ids = parseGroupIdCandidates(spec);
	return ids ? findInDialogs(connection, ids) : null;
}

/** False is a definite "not a member". Anything inconclusive throws. */
export async function probeMembership(
	connection: Connection,
	spec: string,
	me: tl.TypeUser
): Promise<boolean> {
	const hash = parseInviteHash(spec);
	if (hash) return isInviteMember(connection, hash);

	let group: PeerRef | null;
	const username = parseGroupUsername(spec);
	if (username !== null) {
		group = await resolveUsername(connection, username);
		if (!group) {
			log.warn(
				`access group @${username} could not be resolved (is it a public group?) — denying access`
			);
			return false;
		}
	} else {
		const ids = parseGroupIdCandidates(spec);
		if (!ids) {
			log.warn('access group spec is neither a username nor a numeric id — denying access');
			return false;
		}
		group = await findInDialogs(connection, ids);
		if (!group) return false;
	}

	try {
		return await isParticipant(connection, group, me);
	} catch (error) {
		if (isRpc(error, 'USER_NOT_PARTICIPANT')) return false;
		throw StorageError.telegram(
			`group membership check failed: ${StorageError.from(error).message}`
		);
	}
}

async function isInviteMember(connection: Connection, hash: string): Promise<boolean> {
	try {
		const invite = await connection.invoke({ _: 'messages.checkChatInvite', hash });
		return invite._ === 'chatInviteAlready';
	} catch (error) {
		// A bad link is a misconfiguration: fail closed instead of retrying forever.
		if (isRpc(error, 'INVITE_HASH_EXPIRED') || isRpc(error, 'INVITE_HASH_INVALID')) {
			log.warn('access group invite hash is invalid or expired — denying access');
			return false;
		}
		throw StorageError.telegram(
			`checkChatInvite membership probe failed: ${StorageError.from(error).message}`
		);
	}
}

async function isParticipant(
	connection: Connection,
	group: PeerRef,
	me: tl.TypeUser
): Promise<boolean> {
	if (group.kind === 'chat') {
		const { fullChat } = await connection.invoke({ _: 'messages.getFullChat', chatId: group.id });
		return (
			fullChat._ === 'chatFull' &&
			fullChat.participants._ === 'chatParticipants' &&
			fullChat.participants.participants.some((participant) => participant.userId === me.id)
		);
	}
	await connection.invoke({
		_: 'channels.getParticipant',
		channel: telegramPeerAdapter.toInputChannel(group),
		participant: telegramPeerAdapter.toInputPeer(telegramPeerAdapter.fromUser(me))
	});
	return true;
}
