import { log } from '$lib/server/logger';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import { asObject } from '$utils/json/losslessJson';
import type { TelegramFile } from '$types/telegram.type';
import type { FileRow } from '$types/telegram-server.type';
import { StorageError } from './errors';
import { reconcileIndex, reconcileMediaForPipeline, reconcileMetadataOnly } from './reconcile';
import type { TelegramStorage } from './storage';

export function toFileEntry(storage: TelegramStorage, row: FileRow): TelegramFile {
	return telegramFileAdapter.toApi(row, storage.db.isComplete(row));
}

export function uploadedEntry(storage: TelegramStorage, id: string): TelegramFile {
	const row = storage.db.get(id);
	if (!row) throw StorageError.internal('upload row missing after insert');
	return toFileEntry(storage, row);
}

/** The backups, after the once-per-connection walk of the group. */
export async function listFiles(
	storage: TelegramStorage,
	scope: string | null
): Promise<TelegramFile[]> {
	const metadataOnly = scope === 'metadata';
	const connection = storage.current;
	if (connection) {
		try {
			if (metadataOnly) await reconcileMetadataOnly(connection, storage.db);
			else await reconcileIndex(connection, storage.db);
		} catch (error) {
			log.warn(
				`group reconcile failed (continuing with the local index): ${StorageError.from(error).message}`
			);
		}
	}

	const entries = storage.db.list().map((row) => toFileEntry(storage, row));
	if (!metadataOnly) return entries;
	return entries.filter((entry) => asObject(entry.metadata)?.role === 'metadata');
}

/** The media row of a pipeline, indexed from the group if needed. */
export async function loadMediaForPipeline(
	storage: TelegramStorage,
	rawId: string
): Promise<TelegramFile> {
	const id = rawId.trim();
	if (id === '') throw StorageError.badRequest('pipelineId is empty');

	let row = storage.db.findMediaByPipelineId(id);
	if (!row) {
		await reconcileMediaForPipeline(storage.requireConnection(), storage.db, id);
		row = storage.db.findMediaByPipelineId(id);
	}
	if (!row) throw StorageError.notFound();
	return toFileEntry(storage, row);
}
