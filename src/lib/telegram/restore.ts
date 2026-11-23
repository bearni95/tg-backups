import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError, log } from '$lib/logger';
import { originalName } from '$utils/telegram/backupName';
import { StorageError } from './errors';
import type { BackupGroup } from './backup-group';

export interface RestoreOptions {
	/** A folder (the original name goes in it) or a file path. */
	target: string;
	overwrite?: boolean;
	onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

/** Where a restore lands: in the folder under the original name, or at the path. */
export async function restoreTarget(group: BackupGroup, id: string, target: string) {
	const row = group.db.get(id);
	if (!row) throw StorageError.notFound();
	const info = await stat(target).catch(() => null);
	if (!info?.isDirectory()) return target;

	// Names come from captions any group member can write.
	const name = originalName(row.name);
	if (/[/\\]/.test(name) || name === '' || name === '.' || name === '..') {
		throw StorageError.badRequest('stored name is not a plain file name');
	}
	return join(target, name);
}

/**
 * Restore one backup to disk. It is written next to the target and renamed into
 * place only once every byte has arrived, so a cut-short restore leaves nothing
 * that looks like a finished zip. Returns the path written.
 */
export async function restoreToFile(
	group: BackupGroup,
	id: string,
	{ target, overwrite = false, onProgress }: RestoreOptions
): Promise<string> {
	const row = group.db.get(id);
	if (!row) throw StorageError.notFound();
	// Nothing is useful in part of a zip.
	if (!group.db.isComplete(row)) throw StorageError.backupIncomplete();

	const path = await restoreTarget(group, id, target);
	if (!overwrite && (await stat(path).catch(() => null))) {
		throw StorageError.badRequest(`${path} already exists`);
	}

	const total = Math.max(0, row.sizeBytes);
	const bytes = await group.files.downloadRange(id, 0, Math.max(0, total - 1));
	const partial = `${path}.part`;
	const handle = await open(partial, 'w', 0o600);
	let written = 0;
	try {
		onProgress?.(0, total);
		for await (const chunk of bytes) {
			await handle.write(chunk);
			written += chunk.length;
			onProgress?.(written, total);
		}
		await handle.close();
		if (written !== total) {
			throw StorageError.internal(`restore ended after ${written} of ${total} bytes`);
		}
		await rename(partial, path);
		return path;
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(partial, { force: true }).catch((reason) =>
			log.warn(`could not remove ${partial}: ${describeError(reason)}`)
		);
		throw error;
	}
}
