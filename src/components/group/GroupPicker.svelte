<script lang="ts">
	import type { TelegramGroup } from '$types/telegram.type';

	let {
		groups,
		busy = false,
		loading = false,
		onLoad,
		onSelect
	}: {
		/** Null until they have been read from Telegram. */
		groups: TelegramGroup[] | null;
		busy?: boolean;
		loading?: boolean;
		onLoad: () => void;
		onSelect: (id: string) => void;
	} = $props();

	let chosen = $state('');

	function submit(event: Event) {
		event.preventDefault();
		if (chosen) onSelect(chosen);
	}
</script>

<div class="flex flex-col gap-2">
	<h3 class="font-semibold">Use an existing group</h3>
	{#if groups === null}
		<button class="btn self-start" type="button" onclick={onLoad} disabled={busy || loading}>
			{loading ? 'Reading your groups…' : 'Show my groups'}
		</button>
	{:else if groups.length === 0}
		<p class="text-sm opacity-70">This account has no other group it can send files to.</p>
	{:else}
		<form class="flex gap-2" onsubmit={submit}>
			<select
				class="select min-w-0 flex-1"
				aria-label="Existing group"
				bind:value={chosen}
				disabled={busy}
			>
				<option value="" disabled>Choose a group</option>
				{#each groups as group (group.id)}
					<option value={group.id}>{group.title}</option>
				{/each}
			</select>
			<button class="btn" type="submit" disabled={busy || !chosen}>Use group</button>
		</form>
		<p class="text-xs opacity-70">Everyone in that group can see and delete the backups.</p>
	{/if}
</div>
