<script lang="ts">
	import type { TelegramUser } from '$types/telegram.type';
	import TelegramGroupInvite from '$components/telegram/TelegramGroupInvite.svelte';

	let {
		user,
		busy,
		invite = null,
		onRecheck,
		onSignOut
	}: {
		user: TelegramUser | null;
		busy: boolean;
		/** Shareable invite URL for the required group, when the deployment
		 * advertises one — renders a join link + QR so the user can join. */
		invite?: string | null;
		onRecheck: () => void;
		onSignOut: () => void;
	} = $props();

	const displayName = $derived(
		[user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
			(user?.username ? `@${user.username}` : null) ||
			user?.phone ||
			'this account'
	);
</script>

<div class="flex flex-col gap-3">
	<p class="text-sm">
		<span class="font-semibold break-all">{displayName}</span> isn't in the required group.
	</p>
	{#if invite}
		<TelegramGroupInvite {invite} />
	{/if}
	<div class="flex gap-2">
		<button class="btn flex-1 btn-primary" onclick={onRecheck} disabled={busy}>
			{busy ? 'Checking…' : 'Re-check'}
		</button>
		<button class="btn btn-ghost" onclick={onSignOut} disabled={busy}>Sign out</button>
	</div>
</div>
