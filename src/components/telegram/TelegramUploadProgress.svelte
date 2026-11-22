<script lang="ts">
	import { formatBytes, formatBytesPerSec, formatEta } from '$utils/format';
	import type { TelegramUploadSnapshot } from '$types/telegram.type';

	// The live progress block for a Telegram upload: progress bar, byte/percent
	// counters, speed + ETA and chunk tally.
	let { uploads = [] }: { uploads?: TelegramUploadSnapshot[] } = $props();

	// The most-recent upload snapshot for this run (refId === run id); reruns
	// accumulate snapshots, so the latest start wins.
	const upload = $derived.by(() => {
		if (uploads.length === 0) return null;
		return [...uploads].sort((a, b) => b.startedAt - a.startedAt)[0];
	});

	// Telegram upload progress is reported as cumulative bytes; derive the
	// percentage from it.
	const pct = $derived.by(() => {
		if (!upload || upload.totalBytes <= 0) return 0;
		return Math.min(100, (upload.bytesUploaded / upload.totalBytes) * 100);
	});

	// An upload holds a snapshot from the moment it's ENQUEUED, but the queue
	// gate means it can sit (bytesUploaded === 0) for a long time before it
	// actually transfers. `transferStartedAt` is null until then, so this is
	// the honest "waiting in line" state.
	const queued = $derived(
		!!upload && upload.status === 'running' && upload.transferStartedAt == null
	);

	// Speed is the average over the ENTIRE transfer — every byte received since
	// it actually began (`transferStartedAt`, which excludes any queue wait) —
	// rather than only the most recent window. Telegram paces individual parts
	// very unevenly (sub-second to tens of seconds each), so folding in all the
	// data smooths those bursts into a far steadier, more accurate total-time
	// ETA than the last-seen rate. It recomputes each ~1 Hz snapshot poll, so a
	// stall (bytes flat while elapsed grows) correctly bleeds the estimate down.
	//
	// `skippedBytes` are chunks that were already on Telegram and got
	// seek-skipped on resume: they're credited to `bytesUploaded` (so the bar
	// shows true progress) but never crossed the wire, so they're excluded from
	// both the transferred total AND the remaining count here — otherwise the
	// ~1 GB dumped in at `transferStartedAt` would spike the rate and crush the
	// ETA to near-zero right when the real work is only starting.
	const transferredBytes = $derived(
		upload ? Math.max(0, upload.bytesUploaded - upload.skippedBytes) : 0
	);

	const speedBps = $derived.by(() => {
		if (!upload || upload.transferStartedAt == null || transferredBytes <= 0) return 0;
		const end = upload.finishedAt ?? Date.now() / 1000;
		const elapsed = end - upload.transferStartedAt;
		if (elapsed <= 0) return 0;
		return transferredBytes / elapsed;
	});

	const eta = $derived.by(() => {
		if (!upload || upload.totalBytes <= 0 || speedBps <= 0) return null;
		const remaining = upload.totalBytes - upload.bytesUploaded;
		if (remaining <= 0) return null;
		return remaining / speedBps;
	});
</script>

{#if upload}
	<div class="mt-2 space-y-1">
		<progress class="progress w-full progress-info" value={pct} max="100"></progress>
		<div class="flex justify-between text-xs opacity-60">
			<span>
				{formatBytes(upload.bytesUploaded)} / {formatBytes(upload.totalBytes)}
			</span>
			<span>{pct.toFixed(1)}%</span>
		</div>
		<div class="flex justify-between text-xs opacity-60">
			{#if queued}
				<span>Queued…</span>
				<span></span>
			{:else}
				<span>{formatBytesPerSec(speedBps)}</span>
				<span>ETA {formatEta(eta)}</span>
			{/if}
		</div>
		<div class="flex justify-between text-xs opacity-60">
			<span>{upload.chunksCompleted}/{upload.totalChunks} chunks</span>
		</div>
	</div>
{/if}
