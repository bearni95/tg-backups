import { AdapterClass } from '$adapters/classes/adapter.class';
import { parseJson } from '$utils/json/losslessJson';
import { originalName } from '$utils/telegram/backupName';
import type { TelegramFile } from '$types/telegram.type';
import type { FileRow } from '$types/telegram-server.type';

export class TelegramFileAdapter extends AdapterClass {
	constructor() {
		super('telegram-file');
	}

	/** Undefined when the column is empty or not JSON. A stored `null` stays null. */
	metadataFromRow(row: Pick<FileRow, 'metadata'>): unknown {
		if (!row.metadata) return undefined;
		try {
			return parseJson(row.metadata);
		} catch {
			return undefined;
		}
	}

	toApi(row: FileRow, complete: boolean): TelegramFile {
		return {
			id: row.id,
			name: originalName(row.name),
			sizeBytes: row.sizeBytes,
			complete,
			mimeType: row.mimeType,
			createdAt: row.createdAt,
			text: row.text ?? undefined,
			checksumSha256: row.checksumSha256 ?? undefined,
			metadata: this.metadataFromRow(row)
		};
	}
}

export const telegramFileAdapter = new TelegramFileAdapter();
