import { log } from '$lib/server/logger';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import { asObject } from '$utils/json/losslessJson';
import type { TelegramFile } from '$types/telegram.type';
import type { FileRow } from '$types/telegram-server.type';
import { StorageError } from './errors';
import { reconcileIndex, reconcileMediaForPipeline, reconcileMetadataOnly } from './reconcile';
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
export async function listFiles(group: BackupGroup, scope: string | null): Promise<TelegramFile[]> {
	const metadataOnly = scope === 'metadata';
	try {
		if (metadataOnly) await reconcileMetadataOnly(group);
		else await reconcileIndex(group);
	} catch (error) {
		log.warn(
			`group reconcile failed (continuing with the local index): ${StorageError.from(error).message}`
		);
	}

	const entries = group.db.list().map((row) => toFileEntry(group, row));
	if (!metadataOnly) return entries;
	return entries.filter((entry) => asObject(entry.metadata)?.role === 'metadata');
}

/** The media row of a pipeline, indexed from the group if needed. */
export async function loadMediaForPipeline(
	group: BackupGroup,
	rawId: string
): Promise<TelegramFile> {
	const id = rawId.trim();
	if (id === '') throw StorageError.badRequest('pipelineId is empty');

	let row = group.db.findMediaByPipelineId(id);
	if (!row) {
		await reconcileMediaForPipeline(group, id);
		row = group.db.findMediaByPipelineId(id);
	}
	if (!row) throw StorageError.notFound();
	return toFileEntry(group, row);
}
