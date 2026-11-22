import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log } from '$lib/server/logger';
import { storedName } from '$utils/telegram/backupName';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { FileRow } from '$types/telegram-server.type';
import { contentSha256 } from './backup';
import { FileSource, type ByteSource } from './byte-source';
import type { BackupGroup } from './backup-group';
import * as download from './download';
import { StorageError } from './errors';
import { reconcileIndex } from './reconcile';
import { MAX_UPLOAD_BYTES, upload, type UploadRequest, type UploadResult } from './upload';

export type UploadOutcome =
	{ kind: 'uploaded'; result: UploadResult } | { kind: 'alreadyExists'; row: FileRow };

/** The group as a file store. The HTTP routes are thin wrappers over this. */
export class BackupFiles {
	constructor(private readonly group: BackupGroup) {}

	/**
	 * Every upload goes through here: it hashes the content into the stored name,
	 * without which versions with the same name and size would mix.
	 */
	async uploadSource(request: UploadRequest, source: ByteSource): Promise<UploadResult> {
		if (!isAllowedBackup(request.name, request.mimeType)) {
			throw StorageError.unsupportedMediaType(request.name, request.mimeType);
		}
		const digest = await contentSha256(source, request.totalSize, request.abort);
		const named = { ...request, name: storedName(request.name, digest) };
		const result = await upload(this.group, named, source);

		if (result.sha256 !== null && result.sha256 !== digest) {
			// The zip was still being written: what landed isn't what was hashed.
			let note = '';
			try {
				await this.deleteIfExists(result.id);
			} catch (error) {
				log.warn(`could not remove a damaged upload: ${StorageError.from(error).message}`);
				note =
					'; the damaged copy could not be removed and is still listed, so delete it and do not restore it';
			}
			throw StorageError.checksumMismatch(digest, result.sha256, note);
		}
		return result;
	}

	/** The size comes from the disk, whatever the request says. */
	async uploadLocalFile(path: string | Buffer, request: UploadRequest): Promise<UploadResult> {
		const info = await stat(path);
		if (!info.isFile()) throw StorageError.badRequest('path is not a regular file');
		if (info.size > MAX_UPLOAD_BYTES) throw StorageError.fileTooLarge(MAX_UPLOAD_BYTES);

		const handle = await open(path, 'r');
		try {
			return await this.uploadSource({ ...request, totalSize: info.size }, new FileSource(handle));
		} finally {
			await handle.close();
		}
	}

	/** Skips the upload when this exact content is already in the group. */
	async uploadLocalFileDedup(path: string, request: UploadRequest): Promise<UploadOutcome> {
		await reconcileIndex(this.group);

		const handle = await open(path, 'r');
		let digest: string;
		try {
			const { size } = await handle.stat();
			digest = await contentSha256(new FileSource(handle), size, request.abort);
		} finally {
			await handle.close();
		}

		const existing = this.group.db.findByName(storedName(request.name, digest));
		if (existing) return { kind: 'alreadyExists', row: existing };
		return { kind: 'uploaded', result: await this.uploadLocalFile(path, request) };
	}

	async downloadRange(id: string, start: number, end: number) {
		const row = this.require(id);
		return download.downloadRange(this.group, row, start, end);
	}

	async download(id: string) {
		return this.downloadRange(id, 0, Math.max(0, this.require(id).sizeBytes - 1));
	}

	/** Restore into a directory on this machine, under the stored name. */
	async downloadToDir(id: string, directory: string): Promise<string> {
		const { name } = this.require(id);
		// Names come from captions any group member can write.
		if (/[/\\]/.test(name) || name === '' || name === '.' || name === '..') {
			throw StorageError.badRequest('stored name is not a plain file name');
		}
		const bytes = await this.download(id);
		await mkdir(directory, { recursive: true });
		const target = join(directory, name);
		await pipeline(Readable.from(bytes), createWriteStream(target));
		return target;
	}

	/** Re-download and compare with the stored checksum. Rows without one pass. */
	async verify(id: string): Promise<void> {
		const { checksumSha256: expected } = this.require(id);
		if (expected === null) {
			log.warn(`verify(${id}): no stored checksum, skipping`);
			return;
		}
		const hash = createHash('sha256');
		for await (const bytes of await this.download(id)) hash.update(bytes);
		const actual = hash.digest('hex');
		if (actual !== expected) throw StorageError.checksumMismatch(expected, actual);
	}

	async delete(id: string): Promise<void> {
		const row = this.require(id);
		await download.deleteFile(this.group, row);
	}

	async deleteIfExists(id: string): Promise<void> {
		if (this.group.db.get(id)) await this.delete(id);
	}

	async deleteAll(): Promise<number> {
		return download.deleteAll(this.group);
	}

	private require(id: string): FileRow {
		const row = this.group.db.get(id);
		if (!row) throw StorageError.notFound();
		return row;
	}
}
