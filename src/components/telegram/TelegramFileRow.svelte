<script lang="ts">
	import type { TelegramFile } from '$types/telegram.type';
	import { formatBytes } from '$utils/format';

	let {
		file,
		downloadUrl,
		onDelete
	}: {
		file: TelegramFile;
		downloadUrl: string;
		onDelete: (id: string) => void;
	} = $props();

	const created = $derived(new Date(file.createdAt));
	const createdLabel = $derived(
		Number.isNaN(created.valueOf()) ? file.createdAt : created.toLocaleString()
	);

	let confirmingDelete = $state(false);
</script>

<div class="card bg-base-200 shadow-sm">
	<div class="card-body gap-3 p-4 sm:flex-row sm:items-start">
		<div class="flex min-w-0 flex-1 flex-col gap-2">
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0 flex-1">
					<div class="truncate font-medium" title={file.name}>{file.name}</div>
					<div class="truncate font-mono text-xs opacity-60" title={file.id}>
						{file.id}
					</div>
				</div>
				{#if !file.complete}
					<div class="badge badge-warning">Incomplete</div>
				{/if}
			</div>

			<div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
				<div>
					<div class="opacity-60">Size</div>
					<div class="font-mono">{formatBytes(file.sizeBytes)}</div>
				</div>
				<div>
					<div class="opacity-60">Uploaded</div>
					<div class="font-mono">{createdLabel}</div>
				</div>
				{#if file.checksumSha256}
					<div class="min-w-0">
						<div class="opacity-60">SHA-256</div>
						<div class="truncate font-mono" title={file.checksumSha256}>
							{file.checksumSha256.slice(0, 12)}…
						</div>
					</div>
				{/if}
			</div>

			<div class="flex justify-end gap-2">
				{#if file.complete}
					<a class="btn btn-sm btn-primary" href={downloadUrl} download={file.name}>Restore</a>
				{/if}
				{#if confirmingDelete}
					<button class="btn btn-ghost btn-sm" onclick={() => (confirmingDelete = false)}>
						Keep
					</button>
					<button class="btn btn-sm btn-error" onclick={() => onDelete(file.id)}>
						Confirm delete
					</button>
				{:else}
					<button class="btn btn-outline btn-sm btn-error" onclick={() => (confirmingDelete = true)}>
						Delete
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>
