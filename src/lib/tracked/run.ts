// One scheduled backup of a tracked path: zip it if needed, skip it when
// unchanged, upload it, or tell the group it has gone missing.
import type { Stats } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { describeError } from '$lib/logger';
import { sleep } from '$lib/sync';
import { contentSha256 } from '$lib/telegram/backup';
import { FileSource } from '$lib/telegram/byte-source';
import { listFiles } from '$lib/telegram/catalog';
import { sendText } from '$lib/telegram/chat';
import { StorageError } from '$lib/telegram/errors';
import { startUpload } from '$lib/telegram/local-paths';
import type { TelegramStorage } from '$lib/telegram/storage';
import { isInsideAppData } from '$lib/telegram/upload-paths';
import { trackedMessageAdapter } from '$adapters/classes/tracked-message.adapter';
import { storedName } from '$utils/telegram/backupName';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import type { TelegramUploadSnapshot } from '$types/telegram.type';
import type { TrackedPath, TrackedRunOutcome } from '$types/tracked.type';
import { archiveName, writeArchive } from './archive';
import { stagingDir, type TrackedStore } from './store';

/** Errors that mean the path isn't there, as opposed to unreadable. */
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

export type WatchUpload = (uploadId: string) => Promise<TelegramUploadSnapshot>;

export interface RunOptions {
	/** Waits for the queued upload to end. The CLI passes one that draws progress. */
	watch?: WatchUpload;
	now?: () => Date;
	host?: string;
}

/** Waits for the upload without showing anything. */
export function pollUpload(storage: TelegramStorage): WatchUpload {
	return async (uploadId) => {
		for (;;) {
			const upload = storage.uploads.get(uploadId);
			if (!upload) throw StorageError.internal('queued upload vanished');
			if (FINISHED.has(upload.status)) return upload;
			await sleep(200);
		}
	};
}

/** What can be tracked: an existing file or folder outside the app's own data. */
export async function inspectTrackable(path: string, dataRoot: string): Promise<Stats> {
	let info: Stats;
	try {
		info = await stat(path);
	} catch (error) {
		if (MISSING.has((error as NodeJS.ErrnoException).code ?? '')) {
			throw StorageError.badRequest(`${path} does not exist`);
		}
		throw StorageError.from(error);
	}
	if (!info.isFile() && !info.isDirectory()) {
		throw StorageError.badRequest(`${path} is not a file or folder`);
	}
	if (await isInsideAppData(path, dataRoot)) {
		throw StorageError.badRequest("path is inside the app's own data, which is never uploaded");
	}
	return info;
}

async function sha256Of(path: string): Promise<string> {
	const handle = await open(path, 'r');
	try {
		return await contentSha256(new FileSource(handle), (await handle.stat()).size);
	} finally {
		await handle.close();
	}
}

async function reportMissing(
	storage: TelegramStorage,
	store: TrackedStore,
	entry: TrackedPath,
	reason: string,
	options: RunOptions
): Promise<TrackedRunOutcome> {
	const id = String(entry.id);
	const checkedAt = (options.now?.() ?? new Date()).toISOString();
	const group = await storage.groups.resolve(entry.groupId);
	const text = trackedMessageAdapter.missingFile(entry, {
		checkedAt,
		host: options.host ?? hostname(),
		reason
	});
	await sendText(group.connection, group.peer, text);
	const updated = store.update(id, {
		lastRunAt: checkedAt,
		lastStatus: 'missing',
		lastError: `not found (${reason})`
	});
	return { status: 'missing', entry: updated };
}

/**
 * Back up one tracked path now. A zip goes as it is; any other file, or a
 * folder, is zipped first. Content already in the group isn't sent again.
 * A missing path is reported to the group. Failures are recorded, then thrown.
 */
export async function runTracked(
	storage: TelegramStorage,
	store: TrackedStore,
	id: string,
	options: RunOptions = {}
): Promise<TrackedRunOutcome> {
	const entry = store.require(id);
	const startedAt = (options.now?.() ?? new Date()).toISOString();
	await storage.requireAuthorized();

	let info: Stats;
	try {
		info = await stat(entry.path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? '';
		if (MISSING.has(code)) return reportMissing(storage, store, entry, code, options);
		throw record(store, id, startedAt, error);
	}

	const staged = join(stagingDir(storage.dataRoot), `${entry.id}.zip`);
	try {
		const group = await storage.groups.resolve(entry.groupId);
		const asIs = info.isFile() && isAllowedBackup(entry.path, 'application/zip');
		const name = asIs ? basename(entry.path) : archiveName(entry.path);
		const upload = asIs ? entry.path : staged;
		if (!asIs) await writeArchive(entry.path, staged, storage.dataRoot);

		const seen = {
			lastSizeBytes: info.isFile() ? info.size : (await stat(staged)).size,
			lastModifiedAt: info.mtime.toISOString()
		};

		// Reads the group first, so a copy another machine uploaded counts too.
		await listFiles(group, null);
		const existing = group.db.findByName(storedName(name, await sha256Of(upload)));
		if (existing && group.db.isComplete(existing)) {
			const updated = store.update(id, {
				...seen,
				lastRunAt: startedAt,
				lastStatus: 'unchanged',
				lastError: null,
				lastBackupId: existing.id
			});
			return { status: 'unchanged', entry: updated, backupId: existing.id, name };
		}

		const [queued] = await startUpload(storage, group, { path: upload, name });
		const done = await (options.watch ?? pollUpload(storage))(queued.uploadId);
		if (done.status !== 'completed' || !done.fileId) {
			throw StorageError.badRequest(`upload ${done.status}${done.error ? `: ${done.error}` : ''}`);
		}
		const updated = store.update(id, {
			...seen,
			lastRunAt: startedAt,
			lastStatus: 'uploaded',
			lastError: null,
			lastBackupId: done.fileId,
			lastBackupAt: (options.now?.() ?? new Date()).toISOString()
		});
		return { status: 'uploaded', entry: updated, backupId: done.fileId, name };
	} catch (error) {
		throw record(store, id, startedAt, error);
	} finally {
		await rm(staged, { force: true });
	}
}

function record(store: TrackedStore, id: string, at: string, error: unknown): StorageError {
	const mapped = StorageError.from(error);
	try {
		store.update(id, { lastRunAt: at, lastStatus: 'failed', lastError: describeError(mapped) });
	} catch {
		// The entry was removed meanwhile: nothing to record against.
	}
	return mapped;
}
