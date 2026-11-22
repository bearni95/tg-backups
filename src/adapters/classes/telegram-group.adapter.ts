import type { tl } from '@mtcute/node';
import { AdapterClass } from '$adapters/classes/adapter.class';
import { telegramPeerAdapter } from '$adapters/classes/telegram-peer.adapter';
import type { TelegramGroup } from '$types/telegram.type';
import type { PeerRef, SavedGroup } from '$types/telegram-server.type';

const GROUP_ID = /^(channel|chat)-([1-9]\d{0,15})$/;

function canPostFiles(chat: tl.RawChannel | tl.RawChat): boolean {
	if (chat.creator) return true;
	if (chat._ === 'channel' && chat.broadcast) return !!chat.adminRights?.postMessages;
	if (chat.adminRights) return true;
	const own = chat._ === 'channel' ? chat.bannedRights : undefined;
	return ![own, chat.defaultBannedRights].some(
		(rights) => rights?.sendMessages || rights?.sendMedia || rights?.sendDocs
	);
}

export class TelegramGroupAdapter extends AdapterClass {
	constructor() {
		super('telegram-group');
	}

	/** The id used in URLs and file names. Bare ids repeat between the two kinds. */
	idFromPeer({ kind, id }: PeerRef): string {
		return `${kind}-${id}`;
	}

	isGroupId(value: string): boolean {
		return GROUP_ID.test(value);
	}

	/** A chat the account can store backups in, or null. */
	fromChat(chat: tl.TypeChat): SavedGroup | null {
		if (chat._ === 'channel') {
			if (chat.left || chat.min || chat.monoforum || !chat.accessHash) return null;
		} else if (chat._ === 'chat') {
			if (chat.left || chat.deactivated || chat.migratedTo) return null;
		} else {
			return null;
		}
		if (!canPostFiles(chat)) return null;

		const peer = telegramPeerAdapter.fromChat(chat);
		return {
			id: this.idFromPeer(peer),
			title: chat.title,
			accessHash: peer.accessHash.toString()
		};
	}

	toPeer({ id, accessHash }: SavedGroup, parseHash: (value: string) => tl.Long): PeerRef {
		const match = GROUP_ID.exec(id);
		if (!match) throw new Error(`not a group id: ${id}`);
		return {
			kind: match[1] as 'channel' | 'chat',
			id: Number(match[2]),
			accessHash: parseHash(accessHash)
		};
	}

	toApi({ id, title }: SavedGroup): TelegramGroup {
		return { id, title };
	}
}

export const telegramGroupAdapter = new TelegramGroupAdapter();
