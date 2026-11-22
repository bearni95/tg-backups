import { Long, type tl } from '@mtcute/node';
import { AdapterClass } from '$adapters/classes/adapter.class';
import type { PeerRef } from '$types/telegram-server.type';

export class TelegramPeerAdapter extends AdapterClass {
	constructor() {
		super('telegram-peer');
	}

	fromChat(chat: tl.TypeChat): PeerRef {
		if (chat._ === 'channel' || chat._ === 'channelForbidden') {
			return { kind: 'channel', id: chat.id, accessHash: chat.accessHash ?? Long.ZERO };
		}
		return { kind: 'chat', id: chat.id, accessHash: Long.ZERO };
	}

	fromUser(user: tl.TypeUser): PeerRef {
		const accessHash = user._ === 'user' ? user.accessHash : undefined;
		return { kind: 'user', id: user.id, accessHash: accessHash ?? Long.ZERO };
	}

	/** A peer named in a response, with its access hash from the users and chats sent alongside. */
	fromPeer(peer: tl.TypePeer, users: tl.TypeUser[], chats: tl.TypeChat[]): PeerRef {
		switch (peer._) {
			case 'peerUser': {
				const user = users.find((candidate) => candidate.id === peer.userId);
				return user
					? this.fromUser(user)
					: { kind: 'user', id: peer.userId, accessHash: Long.ZERO };
			}
			case 'peerChat':
				return { kind: 'chat', id: peer.chatId, accessHash: Long.ZERO };
			case 'peerChannel': {
				const channel = chats.find(
					(chat) =>
						(chat._ === 'channel' || chat._ === 'channelForbidden') && chat.id === peer.channelId
				);
				return channel
					? this.fromChat(channel)
					: { kind: 'channel', id: peer.channelId, accessHash: Long.ZERO };
			}
		}
	}

	/** Like {@link fromPeer}, but null when the response didn't make the peer addressable. */
	fromResolved(peer: tl.TypePeer, users: tl.TypeUser[], chats: tl.TypeChat[]): PeerRef | null {
		if (peer._ === 'peerChat') return this.fromPeer(peer, users, chats);
		const found =
			peer._ === 'peerUser'
				? users.find((user) => user.id === peer.userId)
				: chats.find((chat) => chat.id === peer.channelId);
		if (!found) return null;
		const addressable =
			found._ === 'channelForbidden' ||
			((found._ === 'user' || found._ === 'channel') && !found.min && !!found.accessHash);
		return addressable ? this.fromPeer(peer, users, chats) : null;
	}

	toInputPeer({ kind, id, accessHash }: PeerRef): tl.TypeInputPeer {
		switch (kind) {
			case 'user':
				return { _: 'inputPeerUser', userId: id, accessHash };
			case 'chat':
				return { _: 'inputPeerChat', chatId: id };
			case 'channel':
				return { _: 'inputPeerChannel', channelId: id, accessHash };
		}
	}

	toInputChannel({ kind, id, accessHash }: PeerRef): tl.TypeInputChannel {
		return kind === 'channel'
			? { _: 'inputChannel', channelId: id, accessHash }
			: { _: 'inputChannelEmpty' };
	}

	matches(peer: tl.TypePeer, ref: PeerRef): boolean {
		switch (peer._) {
			case 'peerUser':
				return ref.kind === 'user' && ref.id === peer.userId;
			case 'peerChat':
				return ref.kind === 'chat' && ref.id === peer.chatId;
			case 'peerChannel':
				return ref.kind === 'channel' && ref.id === peer.channelId;
		}
	}
}

export const telegramPeerAdapter = new TelegramPeerAdapter();
