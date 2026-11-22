<script lang="ts">
	import type { TelegramCodeDelivery, TelegramLoginStage } from '$types/telegram.type';
	import { codeMethodLabel, describeCodeDelivery } from '$utils/telegram/codeDelivery';
	import QrCode from '$components/core/QrCode.svelte';

	let {
		stage,
		delivery = null,
		qrUrl = null,
		busy = false,
		onStart,
		onResend,
		onStartQr,
		onCancelQr,
		onSubmitCode,
		onSubmitPassword
	}: {
		stage: TelegramLoginStage | null;
		delivery?: TelegramCodeDelivery | null;
		/** The `tg://login?token=…` QR being shown; null when QR login isn't running. */
		qrUrl?: string | null;
		busy?: boolean;
		onStart: (phone: string) => void;
		onResend?: () => void;
		onStartQr?: () => void;
		onCancelQr?: () => void;
		onSubmitCode: (code: string) => void;
		onSubmitPassword: (password: string) => void;
	} = $props();

	let phone = $state('');
	let code = $state('');
	let password = $state('');

	function submitPhone(event: Event) {
		event.preventDefault();
		const trimmed = phone.trim();
		if (!trimmed) return;
		onStart(trimmed);
	}

	function submitCode(event: Event) {
		event.preventDefault();
		const trimmed = code.trim();
		if (!trimmed) return;
		onSubmitCode(trimmed);
		code = '';
	}

	function submitPassword(event: Event) {
		event.preventDefault();
		if (!password) return;
		onSubmitPassword(password);
		password = '';
	}
</script>

<div class="flex flex-col gap-3">
	{#if qrUrl && stage !== 'awaiting_password'}
		<div class="flex justify-center">
			<QrCode value={qrUrl} size={220} class="rounded bg-white p-2" />
		</div>
		<p class="text-center text-sm opacity-70">
			Telegram → Settings → Devices → Link Desktop Device
		</p>
		<button type="button" class="btn btn-ghost btn-sm" onclick={onCancelQr}>
			Use phone number
		</button>
	{:else if stage === null}
		<form class="flex gap-2" onsubmit={submitPhone}>
			<input
				class="input-bordered input flex-1"
				type="tel"
				placeholder="+1 555 123 4567"
				bind:value={phone}
				disabled={busy}
			/>
			<button type="submit" class="btn btn-primary" disabled={busy || !phone.trim()}>
				{busy ? 'Sending…' : 'Send code'}
			</button>
		</form>
		{#if onStartQr}
			<button type="button" class="btn btn-ghost btn-sm" onclick={onStartQr} disabled={busy}>
				Use QR code
			</button>
		{/if}
	{:else if stage === 'awaiting_code'}
		<p class="text-sm opacity-70">{describeCodeDelivery(delivery)}</p>
		<form class="flex gap-2" onsubmit={submitCode}>
			<input
				class="input-bordered input flex-1 font-mono"
				type="text"
				inputmode="numeric"
				autocomplete="one-time-code"
				placeholder="12345"
				bind:value={code}
				disabled={busy}
			/>
			<button type="submit" class="btn btn-primary" disabled={busy || !code.trim()}>
				{busy ? 'Verifying…' : 'Verify'}
			</button>
		</form>
		<div class="flex flex-wrap justify-center gap-2">
			{#if onResend && delivery?.nextMethod}
				<button type="button" class="btn btn-ghost btn-sm" onclick={onResend} disabled={busy}>
					Resend via {codeMethodLabel(delivery.nextMethod)}
				</button>
			{/if}
			{#if onStartQr}
				<button type="button" class="btn btn-ghost btn-sm" onclick={onStartQr} disabled={busy}>
					Use QR code
				</button>
			{/if}
		</div>
	{:else if stage === 'awaiting_password'}
		<form class="flex gap-2" onsubmit={submitPassword}>
			<input
				class="input-bordered input flex-1"
				type="password"
				autocomplete="current-password"
				placeholder="cloud password"
				bind:value={password}
				disabled={busy}
			/>
			<button type="submit" class="btn btn-primary" disabled={busy || !password}>
				{busy ? 'Verifying…' : 'Sign in'}
			</button>
		</form>
	{/if}
</div>
