<script lang="ts">
	import { GROUP_PREFIX, groupName } from '$utils/telegram/groupTitle';

	let {
		busy = false,
		onCreate
	}: {
		busy?: boolean;
		onCreate: (title: string) => void;
	} = $props();

	let title = $state('');

	function submit(event: Event) {
		event.preventDefault();
		const name = groupName(title);
		if (name) onCreate(`${GROUP_PREFIX}${name}`);
	}
</script>

<form class="flex flex-col gap-2" onsubmit={submit}>
	<h3 class="font-semibold">Create a group</h3>
	<div class="flex gap-2">
		<label class="input min-w-0 flex-1 gap-0">
			<span>{GROUP_PREFIX}</span>
			<input
				type="text"
				maxlength={128 - GROUP_PREFIX.length}
				placeholder="My backups"
				aria-label="Group name"
				bind:value={title}
				disabled={busy}
			/>
		</label>
		<button class="btn btn-primary" type="submit" disabled={busy || !groupName(title)}>
			{busy ? 'Working…' : 'Create group'}
		</button>
	</div>
	<p class="text-xs opacity-70">
		A private Telegram group, created by the account you signed in with.
	</p>
</form>
