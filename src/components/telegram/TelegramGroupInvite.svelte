<script lang="ts">
	import QrCode from '$components/core/QrCode.svelte';

	let {
		invite,
		title = 'Join the Telegram group',
		description
	}: {
		/** A shareable `https://t.me/…` invite URL for the required group. */
		invite: string;
		title?: string;
		description?: string;
	} = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(invite);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 2000);
		} catch (err) {
			console.error('Failed to copy invite link', err);
		}
	}
</script>

<div class="card bg-base-200 shadow-sm">
	<div class="card-body gap-4 p-4 sm:flex-row sm:items-center">
		<div class="flex justify-center">
			<QrCode value={invite} size={148} class="border border-base-300" />
		</div>
		<div class="min-w-0 flex-1 space-y-2">
			<h3 class="font-semibold">{title}</h3>
			{#if description}
				<p class="text-sm opacity-70">{description}</p>
			{/if}
			<div class="join w-full">
				<input
					class="input-bordered input input-sm join-item w-full font-mono text-xs"
					value={invite}
					readonly
					aria-label="Telegram invite link"
				/>
				<button class="btn join-item btn-sm" onclick={copy}>
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<a class="btn btn-block btn-sm btn-primary" href={invite} target="_blank" rel="noreferrer">
				Open in Telegram
			</a>
		</div>
	</div>
</div>
