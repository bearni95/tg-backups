// Live progress for uploads and restores.
import { emitKeypressEvents } from 'node:readline';
import cliProgress from 'cli-progress';
import { sleep } from '$lib/sync';
import type { UploadRegistry } from '$lib/telegram/uploads';
import { formatBytes, formatBytesPerSec, formatEta } from '$utils/format';
import { uploadProgress } from '$utils/telegram/uploadProgress';
import type { TelegramUploadSnapshot } from '$types/telegram.type';

const POLL_MS = 250;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

function newBars(): cliProgress.MultiBar {
	return new cliProgress.MultiBar(
		{
			format: ' {bar} {percentage}% | {name} | {detail}',
			hideCursor: true,
			clearOnComplete: false,
			stopOnComplete: false,
			autopadding: true,
			barsize: 24,
			stream: process.stderr
		},
		cliProgress.Presets.shades_classic
	);
}

function uploadDetail(upload: TelegramUploadSnapshot): string {
	const view = uploadProgress(upload);
	const bytes = `${formatBytes(upload.bytesUploaded)} / ${formatBytes(upload.totalBytes)}`;
	if (upload.status === 'paused') return `${bytes} | paused`;
	if (FINISHED.has(upload.status)) return `${bytes} | ${upload.status}`;
	if (view.queued) return `${bytes} | queued`;
	return `${bytes} | ${formatBytesPerSec(view.bytesPerSecond)} | ETA ${formatEta(view.etaSeconds)} | chunk ${Math.min(upload.chunksCompleted + 1, upload.totalChunks)}/${upload.totalChunks}`;
}

/**
 * Show the uploads until each one ends, with keys to pause and cancel them.
 * Returns their final snapshots.
 */
export async function watchUploads(
	registry: UploadRegistry,
	ids: string[]
): Promise<TelegramUploadSnapshot[]> {
	const interactive = process.stdin.isTTY && process.stderr.isTTY;
	const bars = interactive ? newBars() : null;
	const shown = new Map<string, cliProgress.SingleBar>();
	let paused = false;
	let cancelled = false;

	const cancelAll = () => {
		if (cancelled) process.exit(130);
		cancelled = true;
		for (const id of ids) registry.cancel(id);
	};
	const onKey = (_text: string, key: { name?: string; ctrl?: boolean } = {}) => {
		if (key.ctrl && key.name === 'c') return cancelAll();
		if (key.name === 'c') return cancelAll();
		if (key.name === 'p') {
			paused = !paused;
			for (const id of ids) {
				if (paused) registry.pause(id);
				else registry.resume(id);
			}
		}
	};

	process.on('SIGINT', cancelAll);
	if (interactive) {
		emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.on('keypress', onKey);
		process.stdin.resume();
		console.error('p: pause or resume   c / Ctrl+C: cancel (run again later to resume)');
	}

	try {
		for (;;) {
			const snapshots = ids.map((id) => registry.get(id)).filter((upload) => upload !== null);
			for (const upload of snapshots) {
				const payload = { name: upload.name, detail: uploadDetail(upload) };
				const percent = Math.floor(uploadProgress(upload).percent);
				const bar = shown.get(upload.uploadId);
				if (bar) bar.update(percent, payload);
				else if (bars) shown.set(upload.uploadId, bars.create(100, percent, payload));
			}
			if (snapshots.every((upload) => FINISHED.has(upload.status))) return snapshots;
			await sleep(POLL_MS);
		}
	} finally {
		bars?.stop();
		process.off('SIGINT', cancelAll);
		if (interactive) {
			process.stdin.off('keypress', onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
	}
}

/** A byte progress bar for a restore; null when stderr isn't a terminal. */
export function restoreBar(name: string) {
	if (!process.stderr.isTTY) return null;
	const bar = new cliProgress.SingleBar(
		{
			format: ' {bar} {percentage}% | {name} | {done} / {all}',
			hideCursor: true,
			barsize: 24,
			stream: process.stderr
		},
		cliProgress.Presets.shades_classic
	);
	let started = false;
	return {
		update(written: number, total: number) {
			const payload = { name, done: formatBytes(written), all: formatBytes(total) };
			if (!started) {
				bar.start(Math.max(1, total), written, payload);
				started = true;
			} else bar.update(written, payload);
		},
		stop() {
			if (started) bar.stop();
		}
	};
}
