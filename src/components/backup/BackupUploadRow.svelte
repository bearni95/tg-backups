<script lang="ts">
	import TelegramUploadProgress from '$components/telegram/TelegramUploadProgress.svelte';
	import type { TelegramUploadSnapshot } from '$types/telegram.type';

	let {
		upload,
		onPause,
		onResume,
		onCancel
	}: {
		upload: TelegramUploadSnapshot;
		onPause: (uploadId: string) => void;
		onResume: (uploadId: string) => void;
		onCancel: (uploadId: string) => void;
	} = $props();

	const active = $derived(upload.status === 'running' || upload.status === 'paused');
</script>

<div class="card bg-base-200 shadow-sm">
	<div class="card-body gap-2 p-4">
		<div class="flex items-center justify-between gap-2">
			<span class="min-w-0 truncate font-medium" title={upload.name}>{upload.name}</span>
			<span class="badge badge-ghost">{upload.status}</span>
		</div>
		<TelegramUploadProgress uploads={[upload]} />
		{#if upload.error}
			<p class="text-sm break-all text-error">{upload.error}</p>
		{/if}
		{#if active}
			<div class="flex justify-end gap-2">
				{#if upload.status === 'paused'}
					<button class="btn btn-sm" onclick={() => onResume(upload.uploadId)}>Resume</button>
				{:else}
					<button class="btn btn-sm" onclick={() => onPause(upload.uploadId)}>Pause</button>
				{/if}
				<button class="btn btn-ghost btn-sm" onclick={() => onCancel(upload.uploadId)}>Cancel</button>
			</div>
		{/if}
	</div>
</div>
