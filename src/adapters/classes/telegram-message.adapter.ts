import type { tl } from '@mtcute/node';
import { AdapterClass } from '$adapters/classes/adapter.class';
import type { StoredDocument } from '$types/telegram-engine.type';

export class TelegramMessageAdapter extends AdapterClass {
	constructor() {
		super('telegram-message');
	}

	textFrom(message: tl.TypeMessage): string {
		return message._ === 'message' ? message.message : '';
	}

	/** The document a message carries. Stickers and every other kind of media are null. */
	documentFrom(message: tl.TypeMessage): StoredDocument | null {
		if (message._ !== 'message' || message.media?._ !== 'messageMediaDocument') return null;
		const document = message.media.document;
		if (document?._ !== 'document') return null;

		let name: string | null = null;
		for (const attribute of document.attributes) {
			if (attribute._ === 'documentAttributeSticker') return null;
			if (attribute._ === 'documentAttributeFilename') name ??= attribute.fileName;
		}
		return {
			name,
			size: document.size,
			mimeType: document.mimeType,
			dcId: document.dcId,
			location: {
				_: 'inputDocumentFileLocation',
				id: document.id,
				accessHash: document.accessHash,
				fileReference: document.fileReference,
				thumbSize: ''
			}
		};
	}

	/** The id Telegram gave the message sent with `randomId`. */
	sentIdFrom(updates: tl.TypeUpdates, randomId: tl.Long): number | null {
		if (updates._ === 'updateShortSentMessage') return updates.id;
		const list =
			updates._ === 'updates' || updates._ === 'updatesCombined'
				? updates.updates
				: updates._ === 'updateShort'
					? [updates.update]
					: [];
		for (const update of list) {
			if (update._ === 'updateMessageID' && update.randomId.eq(randomId)) return update.id;
		}
		return null;
	}
}

export const telegramMessageAdapter = new TelegramMessageAdapter();
