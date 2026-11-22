<script lang="ts">
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
		const trimmed = title.trim();
		if (trimmed) onCreate(trimmed);
	}
</script>

<form class="flex flex-col gap-2" onsubmit={submit}>
	<h3 class="font-semibold">Create a group</h3>
	<div class="flex gap-2">
		<input
			class="input flex-1"
			type="text"
			maxlength="128"
			placeholder="My backups"
			aria-label="Group name"
			bind:value={title}
			disabled={busy}
		/>
		<button class="btn btn-primary" type="submit" disabled={busy || !title.trim()}>
			{busy ? 'Working…' : 'Create group'}
		</button>
	</div>
	<p class="text-xs opacity-70">
		A private Telegram group, created by the account you signed in with.
	</p>
</form>
