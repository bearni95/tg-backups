<script lang="ts">
	import { onMount } from 'svelte';
	import { telegramService } from '$services/telegram.service';
	import BackupUploadForm from '$components/backup/BackupUploadForm.svelte';
	import BackupUploadRow from '$components/backup/BackupUploadRow.svelte';
	import TelegramFileRow from '$components/telegram/TelegramFileRow.svelte';

	const { status, files, uploads, loadingFiles, lastError } = telegramService;

	let busy = $state(false);

	const authorized = $derived($status?.authorized ?? false);
	// The tgb group is the only storage destination: without it nothing can be sent or read.
	const hasGroup = $derived($status?.accessGroupRequired ?? false);
	const ready = $derived(authorized && hasGroup);
	const unfinished = $derived($uploads.filter((upload) => upload.status !== 'completed'));
	const completedCount = $derived($uploads.length - unfinished.length);

	onMount(() => telegramService.watchUploads());

	$effect(() => {
		// Re-read the backups on sign-in and whenever a background upload lands.
		void completedCount;
		if (ready) void telegramService.refreshFiles();
	});

	async function run(action: () => Promise<unknown>) {
		telegramService.clearError();
		try {
			await action();
		} catch (err) {
			telegramService.lastError.set(err instanceof Error ? err.message : String(err));
		}
	}

	async function runBusy(action: () => Promise<unknown>) {
		busy = true;
		await run(action);
		busy = false;
	}
</script>

<svelte:head>
	<title>tg-backups</title>
</svelte:head>

<main class="mx-auto max-w-4xl space-y-4 p-4">
	<header class="flex items-center justify-between gap-2">
		<h1 class="text-2xl font-bold">tg-backups</h1>
		{#if authorized}
			<button class="btn btn-ghost btn-sm" onclick={() => run(() => telegramService.logout())}>
				Sign out
			</button>
		{/if}
	</header>

	{#if $lastError}
		<div class="alert alert-error" role="alert">
			<span class="flex-1 break-all">{$lastError}</span>
			<button class="btn btn-ghost btn-sm" onclick={() => telegramService.clearError()}>
				dismiss
			</button>
		</div>
	{/if}

	{#if authorized && !hasGroup}
		<div class="alert alert-warning" role="alert">
			<span>
				No tgb group is configured. Set <code>TGB_TELEGRAM_ACCESS_GROUP</code> in
				<code>.env</code> to the group's invite link and restart the backend.
			</span>
		</div>
	{:else if ready}
		<BackupUploadForm
			{busy}
			onFile={(file) => runBusy(() => telegramService.uploadFile(file))}
			onPath={(path) => runBusy(() => telegramService.startUpload({ path }))}
		/>

		{#each unfinished as upload (upload.uploadId)}
			<BackupUploadRow
				{upload}
				onPause={(id) => run(() => telegramService.pauseUpload(id))}
				onResume={(id) => run(() => telegramService.resumeUpload(id))}
				onCancel={(id) => run(() => telegramService.cancelUpload(id))}
			/>
		{/each}

		<section class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">Backups</h2>
				<button
					class="btn btn-sm"
					onclick={() => telegramService.refreshFiles()}
					disabled={$loadingFiles}
				>
					{$loadingFiles ? 'Refreshing…' : 'Refresh'}
				</button>
			</div>

			{#each $files as file (file.id)}
				<TelegramFileRow
					{file}
					downloadUrl={telegramService.downloadUrl(file.id)}
					onDelete={(id) => run(() => telegramService.deleteFile(id))}
				/>
			{:else}
				<p class="py-8 text-center opacity-60">
					{$loadingFiles ? 'Reading backups from Telegram…' : 'No backups yet.'}
				</p>
			{/each}
		</section>
	{/if}
</main>
