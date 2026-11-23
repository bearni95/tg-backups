// The message operations the storage needs on the group.
import { randomBytes } from 'node:crypto';
import { Long, type tl } from '@mtcute/node';
import mime from 'mime';
import { telegramMessageAdapter } from '$adapters/classes/telegram-message.adapter';
import { telegramPeerAdapter } from '$adapters/classes/telegram-peer.adapter';
import type { PeerRef } from '$types/telegram-engine.type';
import type { Connection } from './connection';
import { StorageError } from './errors';

const HISTORY_PER_CALL = 100;
/** Telegram's cap on message ids in one call. */
export const MESSAGES_PER_CALL = 100;
const SEND_TIMEOUT_MS = 120_000;

export function randomLong(): Long {
	for (;;) {
		const bytes = randomBytes(8);
		const value = Long.fromBits(bytes.readInt32LE(0), bytes.readInt32LE(4));
		// Telegram has treated 0 as "not set".
		if (!value.isZero()) return value;
	}
}

/** Every message in the group, newest first. */
export async function* iterateHistory(
	connection: Connection,
	peer: PeerRef
): AsyncGenerator<tl.TypeMessage> {
	let offsetId = 0;
	let offsetDate = 0;
	for (;;) {
		const page = await connection.invoke({
			_: 'messages.getHistory',
			peer: telegramPeerAdapter.toInputPeer(peer),
			offsetId,
			offsetDate,
			addOffset: 0,
			limit: HISTORY_PER_CALL,
			maxId: 0,
			minId: 0,
			hash: Long.ZERO
		});
		if (page._ === 'messages.messagesNotModified') {
			throw StorageError.telegram('getHistory returned messagesNotModified');
		}
		const { messages } = page;
		yield* messages;

		// A slice may be short without being the last, so only these end the walk.
		if (page._ === 'messages.messages' || messages.length === 0) return;
		if (messages[0].id <= HISTORY_PER_CALL) return;
		const last = messages[messages.length - 1];
		if (last.id === offsetId) return;
		offsetId = last.id;
		offsetDate = last._ === 'messageEmpty' ? 0 : last.date;
	}
}

/** In the order asked for; null where the message is gone. */
export async function getMessagesById(
	connection: Connection,
	peer: PeerRef,
	ids: number[]
): Promise<(tl.TypeMessage | null)[]> {
	const id = ids.map((value): tl.TypeInputMessage => ({ _: 'inputMessageID', id: value }));
	const result =
		peer.kind === 'channel'
			? await connection.invoke({
					_: 'channels.getMessages',
					channel: telegramPeerAdapter.toInputChannel(peer),
					id
				})
			: await connection.invoke({ _: 'messages.getMessages', id });
	if (result._ === 'messages.messagesNotModified') {
		throw StorageError.telegram('getMessages returned messagesNotModified');
	}

	const found = new Map<number, tl.TypeMessage>();
	for (const message of result.messages) {
		// messageEmpty is how Telegram reports a deleted message.
		if (message._ === 'messageEmpty') continue;
		// Outside channels ids are per account, so it may be another chat's message.
		if (!telegramPeerAdapter.matches(message.peerId, peer)) continue;
		found.set(message.id, message);
	}
	return ids.map((value) => found.get(value) ?? null);
}

export async function deleteMessages(
	connection: Connection,
	peer: PeerRef,
	ids: number[]
): Promise<void> {
	if (peer.kind === 'channel') {
		await connection.invoke({
			_: 'channels.deleteMessages',
			channel: telegramPeerAdapter.toInputChannel(peer),
			id: ids
		});
	} else {
		await connection.invoke({ _: 'messages.deleteMessages', revoke: true, id: ids });
	}
}

/**
 * Delete up to 100 messages, then look at what is really gone. Telegram can
 * answer success having skipped what the account may not delete, and an error
 * can follow a delete that worked.
 */
export async function deleteAndConfirm(
	connection: Connection,
	peer: PeerRef,
	ids: number[]
): Promise<{ deleted: number[]; remaining: number[]; error: unknown }> {
	let failure: unknown = null;
	try {
		await deleteMessages(connection, peer, ids);
	} catch (error) {
		failure = error;
	}
	const found = await getMessagesById(connection, peer, ids);
	return {
		deleted: ids.filter((_, i) => found[i] === null),
		remaining: ids.filter((_, i) => found[i] !== null),
		error: failure
	};
}

/** Telegram's limit for one text message. */
export const MAX_TEXT_LENGTH = 4096;

/** Post a plain text message and return its id. Reconcile skips it: it has no document. */
export async function sendText(
	connection: Connection,
	peer: PeerRef,
	text: string
): Promise<number> {
	const randomId = randomLong();
	const updates = await connection.invoke({
		_: 'messages.sendMessage',
		peer: telegramPeerAdapter.toInputPeer(peer),
		message: text.slice(0, MAX_TEXT_LENGTH),
		noWebpage: true,
		randomId
	});
	const id = telegramMessageAdapter.sentIdFrom(updates, randomId);
	if (id === null) {
		throw StorageError.telegram('sendMessage did not return the id of the sent message');
	}
	return id;
}

/** Post an uploaded file as a document and return its message id. */
export async function sendDocument(
	connection: Connection,
	peer: PeerRef,
	file: tl.RawInputFile | tl.RawInputFileBig,
	caption: string
): Promise<number> {
	const randomId = randomLong();
	const updates = await connection.invoke(
		{
			_: 'messages.sendMedia',
			peer: telegramPeerAdapter.toInputPeer(peer),
			media: {
				_: 'inputMediaUploadedDocument',
				forceFile: true,
				file,
				mimeType: mime.getType(file.name) ?? 'application/octet-stream',
				attributes: [{ _: 'documentAttributeFilename', fileName: file.name }]
			},
			message: caption,
			randomId
		},
		{ timeoutMs: SEND_TIMEOUT_MS }
	);

	const id = telegramMessageAdapter.sentIdFrom(updates, randomId);
	// Never record a chunk without its id: it could not be restored.
	if (id === null) {
		throw StorageError.telegram('sendMedia did not return the id of the sent message');
	}
	return id;
}
