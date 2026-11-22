// What may be uploaded by path: files whose real location is inside the data
// root and outside the app's own state (session, credentials, indexes).
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { StorageError } from './errors';
import { telegramDir } from './paths';

// Bytes throughout: Linux paths needn't be UTF-8.
function isWithin(path: Buffer, directory: Buffer): boolean {
	if (path.equals(directory)) return true;
	const separator = Buffer.from(sep);
	const prefix = directory.subarray(-separator.length).equals(separator)
		? directory
		: Buffer.concat([directory, separator]);
	return path.subarray(0, prefix.length).equals(prefix);
}

async function canonical(path: string): Promise<Buffer> {
	return realpath(path, { encoding: 'buffer' }).catch(() => Buffer.from(resolve(path)));
}

/** Compares real paths, so neither symlinks nor `..` get around it. */
export async function isUnderDataRoot(path: string, root: string): Promise<boolean> {
	return isWithin(await canonical(path), await canonical(root));
}

/** The real path, or null when it may not be uploaded. Throws when it doesn't resolve. */
export async function resolveUploadPath(
	path: string | Buffer,
	dataRoot: string
): Promise<Buffer | null> {
	const real = await realpath(path, { encoding: 'buffer' });
	if (!isWithin(real, await canonical(dataRoot))) return null;
	if (isWithin(real, await canonical(telegramDir(dataRoot)))) return null;
	return real;
}

function notUploadable(): StorageError {
	return StorageError.badRequest('path is not an uploadable file under the storage data root');
}

/**
 * Open for upload, checking again: a queued upload can wait for hours, long
 * enough for its path to become a link to somewhere else.
 */
export async function openUploadFile(path: string | Buffer, dataRoot: string): Promise<FileHandle> {
	const real = await resolveUploadPath(path, dataRoot);
	if (!real) throw notUploadable();

	// NONBLOCK, so a FIFO swapped in can't hang the queue.
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	const handle = await open(real, flags);
	try {
		// The path could change between the check and the open: compare what was opened.
		const opened = await handle.stat();
		const checked = await resolveUploadPath(real, dataRoot);
		const expected = checked && (await stat(checked));
		if (!expected || opened.dev !== expected.dev || opened.ino !== expected.ino) {
			throw notUploadable();
		}
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
