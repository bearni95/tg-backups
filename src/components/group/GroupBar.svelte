<script lang="ts">
	import type { TelegramGroup } from '$types/telegram.type';

	let {
		groups,
		activeId,
		busy = false,
		canShare = false,
		onSelect,
		onAdd,
		onShare
	}: {
		groups: TelegramGroup[];
		activeId: string;
		busy?: boolean;
		canShare?: boolean;
		onSelect: (id: string) => void;
		onAdd: () => void;
		onShare: () => void;
	} = $props();

	function handleChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const id = select.value;
		// Shows the switch only once it has worked: until then the files are the old group's.
		select.value = activeId;
		if (id !== activeId) onSelect(id);
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	<select
		class="select min-w-0 flex-1 font-medium"
		aria-label="Backup group"
		value={activeId}
		onchange={handleChange}
		disabled={busy}
	>
		{#each groups as group (group.id)}
			<option value={group.id}>{group.title}</option>
		{/each}
	</select>
	{#if canShare}
		<button class="btn btn-sm" onclick={onShare}>Share</button>
	{/if}
	<button class="btn btn-sm" onclick={onAdd} disabled={busy}>Add group</button>
</div>
