// Background uploads. In memory only: after a restart, uploading the same zip
// again resumes from the chunks that landed.
import { randomUUID } from 'node:crypto';
import { log } from '$lib/logger';
import { Semaphore } from '$lib/sync';
import type { TelegramChunkSnapshot, TelegramUploadSnapshot } from '$types/telegram.type';
import type { BackupGroup } from './backup-group';
import { AbortControl, PauseControl } from './controls';
import { StorageError } from './errors';
import { chunkCount, MAX_CHUNK_BYTES, type UploadRequest, type UploadResult } from './upload';

/** One file at a time; the rest queue FIFO and show as "Queued". */
export const MAX_CONCURRENT_UPLOADS = 1;

export interface BackgroundUpload {
	/** Fixed when queued: switching groups later doesn't move it. */
	group: BackupGroup;
	/** Bytes when the name isn't valid UTF-8. */
	path: string | Buffer;
	/** For a file found in a folder: the folder it has to stay in. */
	within?: string;
	name: string;
	mimeType: string;
	totalBytes: number;
	refId: string;
	metadata?: unknown;
	text?: string;
}

type RunUpload = (job: BackgroundUpload, request: UploadRequest) => Promise<UploadResult>;

interface ActiveUpload {
	snapshot: TelegramUploadSnapshot;
	pause: PauseControl;
	abort: AbortControl;
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function buildChunkSnapshots(totalBytes: number, count: number): TelegramChunkSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		index,
		bytesUploaded: 0,
		bytesTotal: Math.min(Math.max(0, totalBytes - index * MAX_CHUNK_BYTES), MAX_CHUNK_BYTES),
		status: 'pending'
	}));
}

export function applyChunkProgress(
	snapshot: TelegramUploadSnapshot,
	index: number,
	bytes: number
): void {
	const chunk = snapshot.chunks[index];
	if (!chunk) return;
	chunk.bytesUploaded = Math.min(bytes, chunk.bytesTotal);
	// Only chunk completion marks a chunk done.
	if (chunk.status !== 'done') chunk.status = 'running';
}

export class UploadRegistry {
	private readonly uploads = new Map<string, ActiveUpload>();
	private readonly gate = new Semaphore(MAX_CONCURRENT_UPLOADS);

	constructor(private readonly run: RunUpload) {}

	list(): TelegramUploadSnapshot[] {
		return [...this.uploads.values()]
			.map(({ snapshot }) => structuredClone(snapshot))
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	get(id: string): TelegramUploadSnapshot | null {
		const upload = this.uploads.get(id);
		return upload ? structuredClone(upload.snapshot) : null;
	}

	pause(id: string): boolean {
		const upload = this.uploads.get(id);
		if (!upload) return false;
		upload.pause.pause();
		if (upload.snapshot.status === 'running') upload.snapshot.status = 'paused';
		return true;
	}

	resume(id: string): boolean {
		const upload = this.uploads.get(id);
		if (!upload) return false;
		upload.pause.resume();
		if (upload.snapshot.status === 'paused') upload.snapshot.status = 'running';
		return true;
	}

	cancel(id: string): boolean {
		const upload = this.uploads.get(id);
		if (!upload) return false;
		upload.abort.abort();
		// A paused upload has to wake up to notice.
		upload.pause.resume();
		return true;
	}

	/** Returns at once; the transfer runs in the background. */
	spawn(job: BackgroundUpload): TelegramUploadSnapshot {
		const totalChunks = chunkCount(job.totalBytes);
		const upload: ActiveUpload = {
			pause: new PauseControl(),
			abort: new AbortControl(),
			snapshot: {
				uploadId: randomUUID(),
				refId: job.refId,
				groupId: job.group.id,
				groupTitle: job.group.title,
				name: job.name,
				status: 'running',
				bytesUploaded: 0,
				skippedBytes: 0,
				totalBytes: job.totalBytes,
				chunksCompleted: 0,
				totalChunks,
				fileId: null,
				error: null,
				startedAt: unixSeconds(),
				transferStartedAt: null,
				finishedAt: null,
				chunks: buildChunkSnapshots(job.totalBytes, totalChunks)
			}
		};
		this.uploads.set(upload.snapshot.uploadId, upload);

		const snapshot = structuredClone(upload.snapshot);
		void this.transfer(upload, job);
		return snapshot;
	}

	private async transfer(upload: ActiveUpload, job: BackgroundUpload): Promise<void> {
		const { snapshot, pause, abort } = upload;
		const release = await this.gate.acquire();
		try {
			// Not startedAt: speed and ETA mustn't count the time spent queued.
			snapshot.transferStartedAt = unixSeconds();
			if (abort.isAborted) throw StorageError.uploadAborted();

			const result = await this.run(job, {
				name: job.name,
				mimeType: job.mimeType,
				totalSize: job.totalBytes,
				metadata: job.metadata,
				text: job.text,
				pause,
				abort,
				onProgress: (progress) => {
					snapshot.bytesUploaded = progress.bytesUploaded;
					applyChunkProgress(snapshot, progress.chunkIndex, progress.chunkBytesUploaded);
				},
				onChunk: (done) => {
					snapshot.bytesUploaded = done.bytesUploaded;
					snapshot.chunksCompleted = done.completedCount;
					if (done.skipped) snapshot.skippedBytes += done.chunkSizeBytes;
					const chunk = snapshot.chunks[done.chunkIndex];
					if (!chunk) return;
					chunk.bytesUploaded = chunk.bytesTotal;
					chunk.status = 'done';
				}
			});

			snapshot.status = 'completed';
			snapshot.fileId = result.id;
			snapshot.bytesUploaded = snapshot.totalBytes;
			snapshot.chunksCompleted = snapshot.totalChunks;
			for (const chunk of snapshot.chunks) {
				chunk.bytesUploaded = chunk.bytesTotal;
				chunk.status = 'done';
			}
		} catch (error) {
			const mapped = StorageError.from(error);
			snapshot.status = mapped.code === 'upload_aborted' ? 'cancelled' : 'failed';
			snapshot.error = mapped.message;
			log.warn(`upload ${snapshot.uploadId} ${snapshot.status}: ${mapped.message}`);
		} finally {
			snapshot.finishedAt = unixSeconds();
			release();
		}
	}
}
