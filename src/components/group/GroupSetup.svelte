<script lang="ts">
	import GroupCreateForm from '$components/group/GroupCreateForm.svelte';
	import GroupPicker from '$components/group/GroupPicker.svelte';
	import type { TelegramGroup } from '$types/telegram.type';

	let {
		available,
		busy = false,
		loading = false,
		onCreate,
		onLoad,
		onSelect,
		onClose
	}: {
		available: TelegramGroup[] | null;
		busy?: boolean;
		loading?: boolean;
		onCreate: (title: string) => void;
		onLoad: () => void;
		onSelect: (id: string) => void;
		/** Left out when there is no group to go back to. */
		onClose?: () => void;
	} = $props();
</script>

<section class="card bg-base-200 shadow-sm">
	<div class="card-body gap-4 p-4">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-lg font-semibold">
				{onClose ? 'Add a group' : 'Where should backups be stored?'}
			</h2>
			{#if onClose}
				<button class="btn btn-ghost btn-sm" onclick={onClose}>Cancel</button>
			{/if}
		</div>
		<GroupCreateForm {busy} {onCreate} />
		<div class="divider my-0">or</div>
		<GroupPicker groups={available} {busy} {loading} {onLoad} {onSelect} />
	</div>
</section>
