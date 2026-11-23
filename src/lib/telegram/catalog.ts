import { log } from '$lib/logger';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import type { TelegramFile } from '$types/telegram.type';
import type { FileRow } from '$types/telegram-engine.type';
import { StorageError } from './errors';
import { reconcileIndex } from './reconcile';
import type { BackupGroup } from './backup-group';

export function toFileEntry(group: BackupGroup, row: FileRow): TelegramFile {
	return telegramFileAdapter.toApi(row, group.db.isComplete(row));
}

export function uploadedEntry(group: BackupGroup, id: string): TelegramFile {
	const row = group.db.get(id);
	if (!row) throw StorageError.internal('upload row missing after insert');
	return toFileEntry(group, row);
}

/** The backups, after the once-per-connection walk of the group. */
export async function listFiles(group: BackupGroup): Promise<TelegramFile[]> {
	try {
		await reconcileIndex(group);
	} catch (error) {
		log.warn(
			`group reconcile failed (continuing with the local index): ${StorageError.from(error).message}`
		);
	}
	return group.db.list().map((row) => toFileEntry(group, row));
}
