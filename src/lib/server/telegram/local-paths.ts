// Uploads by path: only from inside the data root.
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import mime from 'mime';
import { log } from '$lib/server/logger';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { TelegramUploadSnapshot } from '$types/telegram.type';
import { StorageError } from './errors';
import type { TelegramStorage } from './storage';
import { MAX_UPLOAD_BYTES, type UploadRequest } from './upload';

export interface PathUploadInput {
	path: string;
	name?: string;
	mimeType?: string;
	metadata?: unknown;
	text?: string;
}

export function guessMime(name: string): string {
	return mime.getType(name) ?? 'application/octet-stream';
}

/** The last component of a path, or null when that is `..` or there is none. */
export function fileNameOf(path: string): string | null {
	const last = path
		.split(sep)
		.filter((part) => part !== '' && part !== '.')
		.pop();
	return last === undefined || last === '..' ? null : last;
}

/** Compares real paths, so neither symlinks nor `..` get around it. */
export async function isUnderDataRoot(path: string, root: string): Promise<boolean> {
	const canonical = await realpath(path).catch(() => resolve(path));
	const canonicalRoot = await realpath(root).catch(() => resolve(root));
	if (canonical === canonicalRoot) return true;
	return canonical.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
}

async function checkPath(storage: TelegramStorage, raw: string) {
	const path = raw.trim();
	if (path === '') throw StorageError.badRequest('path is required');
	if (!isAbsolute(path)) throw StorageError.badRequest('path must be absolute');
	if (!(await isUnderDataRoot(path, storage.dataRoot))) {
		throw StorageError.badRequest('path is not under the storage data root');
	}
	return { path, info: await stat(path) };
}

function describeFile(path: string, size: number, input: PathUploadInput): UploadRequest {
	if (size > MAX_UPLOAD_BYTES) throw StorageError.fileTooLarge(MAX_UPLOAD_BYTES);

	const name = input.name?.trim() || fileNameOf(path);
	if (!name) throw StorageError.badRequest('file name missing');
	const mimeType = input.mimeType?.trim() || guessMime(path);
	if (!isAllowedBackup(name, mimeType)) throw StorageError.unsupportedMediaType(name, mimeType);

	return { name, mimeType, totalSize: size, metadata: input.metadata, text: input.text };
}

/** Upload a file on this machine and wait for it. */
export async function uploadFromPath(
	storage: TelegramStorage,
	input: PathUploadInput
): Promise<string> {
	const { path, info } = await checkPath(storage, input.path);
	if (!info.isFile()) throw StorageError.badRequest('path is not a regular file');
	const request = describeFile(path, info.size, input);
	return (await storage.files.uploadLocalFile(path, request)).id;
}

/** Queue a background upload of a zip, or of every zip under a folder. */
export async function startUpload(
	storage: TelegramStorage,
	input: PathUploadInput & { refId?: string }
): Promise<TelegramUploadSnapshot> {
	const { path, info } = await checkPath(storage, input.path);
	const refId = input.refId?.trim();
	if (info.isDirectory()) return startFolder(storage, path, input, refId);
	if (!info.isFile()) throw StorageError.badRequest('path is not a regular file');

	const { name, mimeType, totalSize } = describeFile(path, info.size, input);
	return storage.uploads.spawn({
		path,
		name,
		mimeType,
		totalBytes: totalSize,
		refId: refId || name,
		metadata: input.metadata,
		text: input.text
	});
}

async function startFolder(
	storage: TelegramStorage,
	folder: string,
	{ metadata, text }: PathUploadInput,
	refId: string | undefined
): Promise<TelegramUploadSnapshot> {
	const files = await collectFiles(folder);
	if (files.length === 0) throw StorageError.badRequest('directory contains no regular files');

	const folderRef = refId || fileNameOf(folder) || '';
	let first: TelegramUploadSnapshot | null = null;
	for (const { path, size } of files) {
		const shown = path.toString();
		if (size > MAX_UPLOAD_BYTES) {
			log.warn(`skipping ${shown}: larger than the upload limit`);
			continue;
		}
		const raw = path.subarray(path.lastIndexOf(sep) + 1);
		const name = raw.toString();
		if (!Buffer.from(name).equals(raw)) throw StorageError.badRequest('file name missing');

		const mimeType = guessMime(name);
		// Skip what sits next to the zips rather than failing the batch.
		if (!isAllowedBackup(name, mimeType)) {
			log.info(`skipping non-zip file ${shown}`);
			continue;
		}
		const spawned = storage.uploads.spawn({
			path,
			name,
			mimeType,
			totalBytes: size,
			refId: folderRef,
			metadata,
			text
		});
		first ??= spawned;
	}

	if (!first) throw StorageError.badRequest('no uploadable files in directory');
	return first;
}

/** Paths are bytes: Linux file names needn't be UTF-8. */
export async function collectFiles(root: string): Promise<{ path: Buffer; size: number }[]> {
	const files: { path: Buffer; size: number }[] = [];
	const pending: Buffer[] = [Buffer.from(root)];
	const separator = Buffer.from(sep);

	for (let directory = pending.pop(); directory; directory = pending.pop()) {
		const prefix =
			directory[directory.length - 1] === separator[0]
				? directory
				: Buffer.concat([directory, separator]);
		for (const entry of await readdir(directory, { encoding: 'buffer' })) {
			const path = Buffer.concat([prefix, entry]);
			const info = await stat(path);
			if (info.isDirectory()) pending.push(path);
			else if (info.isFile()) files.push({ path, size: info.size });
		}
	}

	// By component: `a/z` sorts before `a-b/x`.
	const sortKey = (path: Buffer) =>
		Buffer.from(path.map((byte) => (byte === separator[0] ? 0 : byte)));
	return files.sort((a, b) => Buffer.compare(sortKey(a.path), sortKey(b.path)));
}
