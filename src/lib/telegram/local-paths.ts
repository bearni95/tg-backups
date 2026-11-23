// Uploads by path: a zip, or every zip under a folder.
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import mime from 'mime';
import { log } from '$lib/logger';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { TelegramUploadSnapshot } from '$types/telegram.type';
import type { BackupGroup } from './backup-group';
import { StorageError } from './errors';
import type { TelegramStorage } from './storage';
import { MAX_UPLOAD_BYTES, type UploadRequest } from './upload';
import { resolveUploadPath } from './upload-paths';

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

async function checkPath(storage: TelegramStorage, raw: string) {
	const path = raw.trim();
	if (path === '') throw StorageError.badRequest('path is required');
	if (!isAbsolute(path)) throw StorageError.badRequest('path must be absolute');
	const info = await stat(path);
	// The data root itself is fine as a folder: the walk skips the app's state in it.
	if (!(await resolveUploadPath(path, { dataRoot: storage.dataRoot }))) {
		throw StorageError.badRequest("path is inside the app's own data, which is never uploaded");
	}
	return { path, info };
}

function describeFile(path: string, size: number, input: PathUploadInput): UploadRequest {
	if (size > MAX_UPLOAD_BYTES) throw StorageError.fileTooLarge(MAX_UPLOAD_BYTES);

	const name = input.name?.trim() || fileNameOf(path);
	if (!name) throw StorageError.badRequest('file name missing');
	const mimeType = input.mimeType?.trim() || guessMime(path);
	if (!isAllowedBackup(name, mimeType)) throw StorageError.unsupportedMediaType(name, mimeType);

	return { name, mimeType, totalSize: size, metadata: input.metadata, text: input.text };
}

/**
 * Queue a zip, or every zip under a folder, and return their snapshots in
 * queue order. The uploads run one at a time in the background.
 */
export async function startUpload(
	storage: TelegramStorage,
	group: BackupGroup,
	input: PathUploadInput & { refId?: string }
): Promise<TelegramUploadSnapshot[]> {
	const { path, info } = await checkPath(storage, input.path);
	const refId = input.refId?.trim();
	if (info.isDirectory()) return startFolder(storage, group, path, input, refId);
	if (!info.isFile()) throw StorageError.badRequest('path is not a regular file');

	const { name, mimeType, totalSize } = describeFile(path, info.size, input);
	return [
		storage.uploads.spawn({
			group,
			path,
			name,
			mimeType,
			totalBytes: totalSize,
			refId: refId || name,
			metadata: input.metadata,
			text: input.text
		})
	];
}

async function startFolder(
	storage: TelegramStorage,
	group: BackupGroup,
	folder: string,
	{ metadata, text }: PathUploadInput,
	refId: string | undefined
): Promise<TelegramUploadSnapshot[]> {
	const files = await collectFiles(folder, storage.dataRoot);
	if (files.length === 0)
		throw StorageError.badRequest(
			'directory contains no regular files (links out of the folder are not followed)'
		);

	const folderRef = refId || fileNameOf(folder) || '';
	const spawned: TelegramUploadSnapshot[] = [];
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
		spawned.push(
			storage.uploads.spawn({
				group,
				path,
				within: folder,
				name,
				mimeType,
				totalBytes: size,
				refId: folderRef,
				metadata,
				text
			})
		);
	}

	if (spawned.length === 0) throw StorageError.badRequest('no uploadable files in directory');
	return spawned;
}

/** Errors of a link that leads nowhere readable. */
const BROKEN_LINK = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES']);

/**
 * Every file under a folder whose real location may be uploaded. Links are
 * followed only within the folder, and each real folder is read once, so
 * loops end. Paths are bytes: Linux file names needn't be UTF-8.
 */
export async function collectFiles(
	root: string,
	dataRoot: string
): Promise<{ path: Buffer; size: number }[]> {
	const files: { path: Buffer; size: number }[] = [];
	const scope = { dataRoot, within: root };
	const start = await resolveUploadPath(root, scope);
	if (!start) return files;

	const visited = new Set([start.toString('latin1')]);
	const pending: Buffer[] = [Buffer.from(root)];
	const separator = Buffer.from(sep);

	for (let directory = pending.pop(); directory; directory = pending.pop()) {
		const prefix =
			directory[directory.length - 1] === separator[0]
				? directory
				: Buffer.concat([directory, separator]);
		for (const entry of await readdir(directory, { encoding: 'buffer' })) {
			const path = Buffer.concat([prefix, entry]);

			let real: Buffer | null;
			try {
				real = await resolveUploadPath(path, scope);
			} catch (error) {
				if (!BROKEN_LINK.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
				log.info(`skipping ${path.toString()}: it doesn't resolve`);
				continue;
			}
			if (!real) {
				log.info(`skipping ${path.toString()}: outside the folder, or the app's own data`);
				continue;
			}

			const info = await stat(real);
			if (info.isDirectory()) {
				const key = real.toString('latin1');
				if (visited.has(key)) continue;
				visited.add(key);
				pending.push(path);
			} else if (info.isFile()) {
				files.push({ path, size: info.size });
			}
		}
	}

	// By component: `a/z` sorts before `a-b/x`.
	const sortKey = (path: Buffer) =>
		Buffer.from(path.map((byte) => (byte === separator[0] ? 0 : byte)));
	return files.sort((a, b) => Buffer.compare(sortKey(a.path), sortKey(b.path)));
}
