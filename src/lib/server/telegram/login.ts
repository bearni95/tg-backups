import type { tl } from '@mtcute/node';
import { log } from '$lib/server/logger';
import { Semaphore } from '$lib/server/sync';
import { telegramAuthAdapter } from '$adapters/classes/telegram-auth.adapter';
import type {
	TelegramAuthOutcome,
	TelegramCodeDelivery,
	TelegramLoginStage,
	TelegramQrStep
} from '$types/telegram.type';
import * as auth from './auth';
import type { Connection } from './connection';
import { StorageError } from './errors';

type InProgress =
	| { stage: 'code'; request: auth.CodeRequest; delivery: TelegramCodeDelivery }
	| { stage: 'password'; password: tl.account.RawPassword };

/** The login wizard's state. One login at a time. */
export class LoginFlow {
	private state: InProgress | null = null;
	// Held across the RPC, so a resend can't race a code submit for the hash.
	private readonly lock = new Semaphore();

	constructor(private readonly connection: () => Connection) {}

	progress(): Promise<{
		stage: TelegramLoginStage | null;
		delivery: TelegramCodeDelivery | null;
	}> {
		return this.lock.run(() => {
			if (this.state?.stage === 'code') {
				return { stage: 'awaiting_code' as const, delivery: this.state.delivery };
			}
			const stage = this.state ? ('awaiting_password' as const) : null;
			return { stage, delivery: null };
		});
	}

	reset(): Promise<void> {
		return this.lock.run(() => {
			this.state = null;
		});
	}

	async start(phone: string): Promise<TelegramCodeDelivery> {
		const sent = await auth.requestCode(this.connection(), phone);
		return this.lock.run(() => {
			this.state = { stage: 'code', ...sent };
			return sent.delivery;
		});
	}

	resend(): Promise<TelegramCodeDelivery> {
		return this.lock.run(async () => {
			if (this.state?.stage !== 'code') throw StorageError.noLoginInProgress();
			const sent = await auth.resendCode(this.connection(), this.state.request);
			this.state = { stage: 'code', ...sent };
			return sent.delivery;
		});
	}

	submitCode(code: string): Promise<TelegramAuthOutcome> {
		return this.lock.run(async () => {
			if (this.state?.stage !== 'code') throw StorageError.noLoginInProgress();
			// The pending code stays until Telegram accepts one, so a typo can be retyped.
			const step = await auth.submitCode(this.connection(), this.state.request, code);
			return this.finish(step);
		});
	}

	async qrStep(): Promise<TelegramQrStep> {
		const step = await auth.qrLoginStep(this.connection());
		if (step.kind === 'pending') {
			return { outcome: 'pending', url: step.url, expiresAt: step.expiresAt };
		}
		log.info(`qr login: approved (${step.kind})`);
		return this.lock.run(() => this.finish(step));
	}

	async submitPassword(input: string): Promise<TelegramAuthOutcome> {
		const password = await this.lock.run(() => {
			if (this.state?.stage !== 'password') throw StorageError.noLoginInProgress();
			const pending = this.state.password;
			// An SRP challenge is single-use.
			this.state = null;
			return pending;
		});
		const user = await auth.submitPassword(this.connection(), password, input);
		return { outcome: 'authenticated', user: telegramAuthAdapter.userFromTl(user) };
	}

	private finish(step: auth.SignInStep): TelegramAuthOutcome {
		if (step.kind === 'authenticated') {
			this.state = null;
			return { outcome: 'authenticated', user: telegramAuthAdapter.userFromTl(step.user) };
		}
		this.state = { stage: 'password', password: step.password };
		return { outcome: 'passwordRequired', hint: step.password.hint ?? null };
	}
}
