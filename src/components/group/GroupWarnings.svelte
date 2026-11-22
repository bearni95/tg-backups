<script lang="ts">
	import { formatEta } from '$utils/format';
	import type { TelegramGroupInfo } from '$types/telegram.type';

	let { info }: { info: TelegramGroupInfo } = $props();
</script>

{#if info.autoDeleteSeconds}
	<div class="alert alert-error" role="alert">
		<span>
			This group deletes messages after {formatEta(info.autoDeleteSeconds)}, and backups with them.
			Turn auto-delete off in Telegram before storing anything here.
		</span>
	</div>
{/if}
{#if info.historyHidden}
	<div class="alert alert-warning" role="alert">
		<span>
			New members can't see older messages here, so they won't see existing backups. Set "Chat
			history for new members" to visible in Telegram.
		</span>
	</div>
{/if}
