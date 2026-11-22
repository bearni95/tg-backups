<script lang="ts">
	import { onMount } from 'svelte';
	import { telegramService } from '$services/telegram.service';
	import BackupUploadForm from '$components/backup/BackupUploadForm.svelte';
	import BackupUploadRow from '$components/backup/BackupUploadRow.svelte';
	import GroupBar from '$components/group/GroupBar.svelte';
	import GroupSetup from '$components/group/GroupSetup.svelte';
	import GroupWarnings from '$components/group/GroupWarnings.svelte';
	import TelegramFileRow from '$components/telegram/TelegramFileRow.svelte';
	import TelegramGroupInvite from '$components/telegram/TelegramGroupInvite.svelte';

	const {
		status,
		files,
		uploads,
		loadingFiles,
		lastError,
		groupInfo,
		availableGroups,
		loadingGroups
	} = telegramService;

	let busy = $state(false);
	let addingGroup = $state(false);
	let sharing = $state(false);

	const authorized = $derived($status?.authorized ?? false);
	const groups = $derived($status?.groups ?? []);
	const activeGroupId = $derived($status?.activeGroupId ?? null);
	const unfinished = $derived($uploads.filter((upload) => upload.status !== 'completed'));
	const completedCount = $derived($uploads.length - unfinished.length);

	onMount(() => telegramService.watchUploads());

	$effect(() => {
		// A different group, possibly switched from another tab.
		void activeGroupId;
		addingGroup = false;
		sharing = false;
		if (authorized && activeGroupId) void telegramService.refreshGroupInfo();
	});

	$effect(() => {
		// Re-read the backups on sign-in, on a switch, and whenever a background upload lands.
		void completedCount;
		if (authorized && activeGroupId) void telegramService.refreshFiles();
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

	function createGroup(title: string) {
		return runBusy(async () => {
			await telegramService.createGroup(title);
			addingGroup = false;
		});
	}

	function selectGroup(id: string) {
		return runBusy(async () => {
			await telegramService.selectGroup(id);
			addingGroup = false;
		});
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

	{#if authorized}
		{#if activeGroupId}
			<GroupBar
				{groups}
				activeId={activeGroupId}
				{busy}
				canShare={!!$groupInfo?.invite}
				onSelect={selectGroup}
				onAdd={() => (addingGroup = true)}
				onShare={() => (sharing = !sharing)}
			/>
			{#if sharing && $groupInfo?.invite}
				<TelegramGroupInvite
					invite={$groupInfo.invite}
					title="Share this group"
					description="Anyone with this link can join, then see and delete its backups."
				/>
			{/if}
			{#if $groupInfo}
				<GroupWarnings info={$groupInfo} />
			{/if}
		{/if}

		{#if !activeGroupId || addingGroup}
			<GroupSetup
				available={$availableGroups}
				{busy}
				loading={$loadingGroups}
				onCreate={createGroup}
				onSelect={selectGroup}
				onLoad={() => telegramService.loadAvailableGroups()}
				onClose={activeGroupId ? () => (addingGroup = false) : undefined}
			/>
		{/if}

		{#if activeGroupId}
			<BackupUploadForm
				{busy}
				onFile={(file) => runBusy(() => telegramService.uploadFile(file))}
				onPath={(path) => runBusy(() => telegramService.startUpload({ path }))}
			/>
		{/if}

		{#each unfinished as upload (upload.uploadId)}
			<BackupUploadRow
				{upload}
				onPause={(id) => run(() => telegramService.pauseUpload(id))}
				onResume={(id) => run(() => telegramService.resumeUpload(id))}
				onCancel={(id) => run(() => telegramService.cancelUpload(id))}
			/>
		{/each}

		{#if activeGroupId}
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
						downloadUrl={telegramService.downloadUrl(file.id, activeGroupId)}
						onDelete={(id) => run(() => telegramService.deleteFile(id))}
					/>
				{:else}
					<p class="py-8 text-center opacity-60">
						{$loadingFiles ? 'Reading backups from Telegram…' : 'No backups yet.'}
					</p>
				{/each}
			</section>
		{/if}
	{/if}
</main>
