<script lang="ts">
	import { onMount } from 'svelte';
	import { telegramService } from '$services/telegram.service';
	import TelegramCredentialsForm from '$components/telegram/TelegramCredentialsForm.svelte';
	import TelegramAuthWizard from '$components/telegram/TelegramAuthWizard.svelte';
	import TelegramQrLogin from '$components/telegram/TelegramQrLogin.svelte';
	import classNames from 'classnames';
	import type { TelegramCredentials } from '$types/telegram.type';

	const status = telegramService.status;
	const lastError = telegramService.lastError;
	const optimisticAuthorized = telegramService.optimisticAuthorized;
	const qrLogin = telegramService.qrLogin;

	let credentials = $state<TelegramCredentials | null>(null);
	let credentialsLoaded = $state(false);
	let busy = $state(false);

	const stage = $derived($status?.loginInProgress ?? null);
	const hasCredentials = $derived($status?.hasCredentials ?? false);
	const authorized = $derived($status?.authorized ?? false);
	const signedIn = $derived($status?.signedIn ?? false);
	const showCredentialsForm = $derived(!hasCredentials || credentials === null);

	// The gate blocks the whole UI until Telegram sign-in completes. Before
	// the first `/status` poll resolves we honour the persisted "authorized
	// until" hint so a reload within the bypass window opens instantly; once a
	// real status has arrived (`$status !== null`) it is authoritative.
	const gated = $derived(!authorized && !($status === null && $optimisticAuthorized));

	onMount(() => {
		telegramService.start();
		void loadCredentials();
		return () => telegramService.stopQrLogin();
	});

	// Open with the QR code: phone-number login depends on Telegram actually
	// delivering the code, which it silently skips for some accounts / api_ids.
	// Auto-start only once, so choosing "use a phone number" (or a failed QR
	// poll) isn't immediately overridden.
	let qrAutoStarted = false;
	$effect(() => {
		if (qrAutoStarted || !gated || !credentialsLoaded || !$status) return;
		if (signedIn || showCredentialsForm || stage === 'awaiting_password') return;
		qrAutoStarted = true;
		telegramService.startQrLogin();
	});

	async function loadCredentials() {
		try {
			credentials = await telegramService.getCredentials();
		} catch {
			credentials = null;
		} finally {
			credentialsLoaded = true;
		}
	}

	async function handleSaveCredentials(apiId: number, apiHash: string) {
		busy = true;
		try {
			await telegramService.setCredentials(apiId, apiHash);
			await loadCredentials();
		} catch (err) {
			console.error('Failed to save credentials', err);
		} finally {
			busy = false;
		}
	}

	async function handleStartAuth(phone: string) {
		busy = true;
		try {
			await telegramService.startAuth(phone);
		} finally {
			busy = false;
		}
	}

	async function handleResendCode() {
		busy = true;
		try {
			await telegramService.resendCode();
		} finally {
			busy = false;
		}
	}

	async function handleSubmitCode(code: string) {
		busy = true;
		try {
			await telegramService.submitCode(code);
		} finally {
			busy = false;
		}
	}

	async function handleSubmitPassword(password: string) {
		busy = true;
		try {
			await telegramService.submitPassword(password);
		} finally {
			busy = false;
		}
	}

	async function handleClearCredentials() {
		busy = true;
		try {
			await telegramService.deleteCredentials();
			credentials = null;
		} finally {
			busy = false;
		}
	}
</script>

{#if gated}
	<div class="modal-open modal" role="dialog" aria-modal="true">
		<div
			class="modal-box flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-4 overflow-y-auto rounded-none p-4 md:overflow-hidden md:p-6"
		>
			<h2 class="shrink-0 text-lg font-bold">Sign in to Telegram</h2>

			{#if $lastError}
				<div class="alert shrink-0 py-2 alert-error">
					<span class="flex-1 text-sm break-all">{$lastError}</span>
					<button class="btn btn-ghost btn-xs" onclick={() => telegramService.clearError()}>
						✕
					</button>
				</div>
			{/if}

			{#if !credentialsLoaded || !$status || signedIn}
				<div class="flex flex-1 items-center justify-center">
					<span class="loading loading-spinner"></span>
				</div>
			{:else}
				<div class="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-3">
					<section class="card min-h-0 overflow-y-auto bg-base-200">
						<div class="card-body gap-3 p-4">
							<h3 class="font-semibold">Credentials</h3>
							{#if showCredentialsForm}
								<TelegramCredentialsForm
									initialApiId={credentials ? String(credentials.apiId) : ''}
									initialApiHash={credentials?.apiHash ?? ''}
									{busy}
									onSubmit={handleSaveCredentials}
								/>
							{:else}
								<div class="flex items-center justify-between gap-2">
									<span class="text-sm">
										api_id <span class="font-mono">{credentials?.apiId ?? ''}</span>
									</span>
									<button
										class="btn btn-ghost btn-sm"
										onclick={handleClearCredentials}
										disabled={busy}
									>
										clear
									</button>
								</div>
							{/if}
						</div>
					</section>

					<section class="card min-h-0 overflow-y-auto bg-base-200">
						<div class="card-body gap-3 p-4">
							<h3 class="font-semibold">QR code</h3>
							<TelegramQrLogin
								qrUrl={$qrLogin?.url ?? null}
								disabled={showCredentialsForm || stage === 'awaiting_password'}
								onStart={() => telegramService.startQrLogin()}
							/>
						</div>
					</section>

					<section class="card min-h-0 overflow-y-auto bg-base-200">
						<div class="card-body gap-3 p-4">
							<h3 class="font-semibold">Phone number</h3>
							<fieldset
								disabled={showCredentialsForm}
								class={classNames({ 'opacity-50': showCredentialsForm })}
							>
								<TelegramAuthWizard
									{stage}
									delivery={$status?.codeDelivery ?? null}
									{busy}
									onStart={handleStartAuth}
									onResend={handleResendCode}
									onSubmitCode={handleSubmitCode}
									onSubmitPassword={handleSubmitPassword}
								/>
							</fieldset>
						</div>
					</section>
				</div>
			{/if}
		</div>
	</div>
{/if}
