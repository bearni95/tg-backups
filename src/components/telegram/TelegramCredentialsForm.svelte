<script lang="ts">
	import { untrack } from 'svelte';

	let {
		initialApiId = '',
		initialApiHash = '',
		busy = false,
		onSubmit
	}: {
		initialApiId?: string;
		initialApiHash?: string;
		busy?: boolean;
		onSubmit: (apiId: number, apiHash: string) => void;
	} = $props();

	let apiId = $state(untrack(() => initialApiId));
	let apiHash = $state(untrack(() => initialApiHash));

	const parsedApiId = $derived(Number.parseInt(apiId, 10));
	const valid = $derived(
		Number.isFinite(parsedApiId) && parsedApiId > 0 && apiHash.trim().length > 0
	);

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (!valid) return;
		onSubmit(parsedApiId, apiHash.trim());
	}
</script>

<form class="flex flex-col gap-3" onsubmit={handleSubmit}>
	<input
		class="input-bordered input w-full"
		type="text"
		inputmode="numeric"
		placeholder="123456"
		aria-label="api_id"
		bind:value={apiId}
		disabled={busy}
	/>
	<input
		class="input-bordered input w-full font-mono"
		type="text"
		placeholder="0123456789abcdef0123456789abcdef"
		aria-label="api_hash"
		bind:value={apiHash}
		disabled={busy}
	/>
	<div class="flex items-center justify-between gap-2">
		<a
			class="link text-sm opacity-70"
			href="https://my.telegram.org/apps"
			target="_blank"
			rel="noreferrer"
		>
			my.telegram.org/apps
		</a>
		<button type="submit" class="btn btn-primary" disabled={!valid || busy}>
			{busy ? 'Saving…' : 'Save'}
		</button>
	</div>
</form>
