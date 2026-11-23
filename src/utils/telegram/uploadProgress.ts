import type { TelegramUploadSnapshot } from '$types/telegram.type';

export interface UploadProgressView {
	/** 0 to 100. */
	percent: number;
	/** Still waiting for the one-at-a-time queue. */
	queued: boolean;
	bytesPerSecond: number;
	/** Seconds left, or null when unknown. */
	etaSeconds: number | null;
}

/**
 * Speed is averaged over the whole transfer since it left the queue: Telegram
 * paces parts unevenly, and a short window makes the ETA jump around. Chunks
 * skipped on a resume never crossed the wire, so they count toward progress
 * but not toward speed.
 */
export function uploadProgress(
	upload: TelegramUploadSnapshot,
	nowSeconds: number = Date.now() / 1000
): UploadProgressView {
	const percent =
		upload.totalBytes > 0 ? Math.min(100, (upload.bytesUploaded / upload.totalBytes) * 100) : 0;
	const queued = upload.status === 'running' && upload.transferStartedAt == null;

	const transferred = Math.max(0, upload.bytesUploaded - upload.skippedBytes);
	let bytesPerSecond = 0;
	if (upload.transferStartedAt != null && transferred > 0) {
		const elapsed = (upload.finishedAt ?? nowSeconds) - upload.transferStartedAt;
		if (elapsed > 0) bytesPerSecond = transferred / elapsed;
	}

	const remaining = upload.totalBytes - upload.bytesUploaded;
	const etaSeconds =
		upload.totalBytes > 0 && bytesPerSecond > 0 && remaining > 0
			? remaining / bytesPerSecond
			: null;

	return { percent, queued, bytesPerSecond, etaSeconds };
}
