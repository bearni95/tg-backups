<script lang="ts">
	let {
		busy = false,
		onFile,
		onPath
	}: {
		busy?: boolean;
		onFile: (file: File) => void;
		/** A zip, or a folder of zips, already inside the backend's data folder. */
		onPath: (path: string) => void;
	} = $props();

	let path = $state('');

	function handleFileChosen(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) onFile(file);
	}

	function submitPath(event: Event) {
		event.preventDefault();
		const trimmed = path.trim();
		if (trimmed) onPath(trimmed);
	}
</script>

<div class="card bg-base-200 shadow-sm">
	<div class="card-body gap-3 p-4">
		<h2 class="font-semibold">New backup</h2>
		<input
			class="file-input w-full"
			type="file"
			accept=".zip"
			aria-label="Zip file"
			onchange={handleFileChosen}
			disabled={busy}
		/>
		<form class="flex gap-2" onsubmit={submitPath}>
			<input
				class="input flex-1 font-mono"
				type="text"
				placeholder="/home/you/tg-backups/backup.zip"
				aria-label="Server path"
				bind:value={path}
				disabled={busy}
			/>
			<button class="btn btn-primary" type="submit" disabled={busy || !path.trim()}>
				Back up path
			</button>
		</form>
		<p class="text-xs opacity-70">
			For large zips use a path inside the data folder (~/tg-backups): it uploads in the background,
			with pause and progress.
		</p>
		{#if busy}
			<p class="text-sm" role="status">Sending… keep this tab open.</p>
		{/if}
	</div>
</div>
