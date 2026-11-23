// What may be uploaded by path: anything the user names, except the app's own
// state (session, credentials, indexes). Inside a folder, links are followed
// only while they stay in that folder.
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { StorageError } from './errors';
import { telegramDir } from './paths';

export interface UploadScope {
	/** Its `telegram` folder is never uploaded. */
	dataRoot: string;
	/** When set, the real path has to stay inside this folder. */
	within?: string | Buffer;
}

// Bytes throughout: Linux paths needn't be UTF-8.
function isWithin(path: Buffer, directory: Buffer): boolean {
	if (path.equals(directory)) return true;
	const separator = Buffer.from(sep);
	const prefix = directory.subarray(-separator.length).equals(separator)
		? directory
		: Buffer.concat([directory, separator]);
	return path.subarray(0, prefix.length).equals(prefix);
}

async function canonical(path: string | Buffer): Promise<Buffer> {
	return realpath(path, { encoding: 'buffer' }).catch(() => Buffer.from(resolve(path.toString())));
}

/** Compares real paths, so neither symlinks nor `..` get around it. */
export async function isInsideAppData(path: string, dataRoot: string): Promise<boolean> {
	return isWithin(await canonical(path), await canonical(telegramDir(dataRoot)));
}

/** The real path, or null when it may not be uploaded. Throws when it doesn't resolve. */
export async function resolveUploadPath(
	path: string | Buffer,
	scope: UploadScope
): Promise<Buffer | null> {
	const real = await realpath(path, { encoding: 'buffer' });
	if (scope.within !== undefined && !isWithin(real, await canonical(scope.within))) return null;
	if (isWithin(real, await canonical(telegramDir(scope.dataRoot)))) return null;
	return real;
}

function notUploadable(): StorageError {
	return StorageError.badRequest('path is not an uploadable file');
}

/**
 * Open for upload, checking again: a queued upload can wait for hours, long
 * enough for its path to become a link to somewhere else.
 */
export async function openUploadFile(
	path: string | Buffer,
	scope: UploadScope
): Promise<FileHandle> {
	const real = await resolveUploadPath(path, scope);
	if (!real) throw notUploadable();

	// NONBLOCK, so a FIFO swapped in can't hang the queue.
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	const handle = await open(real, flags);
	try {
		// The path could change between the check and the open: compare what was opened.
		const opened = await handle.stat();
		const checked = await resolveUploadPath(real, scope);
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
