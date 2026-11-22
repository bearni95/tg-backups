<script lang="ts">
	import QrCode from '$components/core/QrCode.svelte';

	let {
		qrUrl = null,
		disabled = false,
		onStart
	}: {
		/** The `tg://login?token=…` QR being shown; null when QR login isn't running. */
		qrUrl?: string | null;
		disabled?: boolean;
		onStart: () => void;
	} = $props();
</script>

<div class="flex flex-col items-center gap-3">
	{#if qrUrl && !disabled}
		<QrCode value={qrUrl} size={220} class="max-w-full rounded bg-white p-2" />
		<p class="text-center text-sm opacity-70">
			Telegram → Settings → Devices → Link Desktop Device
		</p>
	{:else}
		<div
			class="flex aspect-square w-[236px] max-w-full items-center justify-center rounded bg-base-300"
		>
			<button type="button" class="btn btn-sm" onclick={onStart} {disabled}>Show QR code</button>
		</div>
	{/if}
</div>
