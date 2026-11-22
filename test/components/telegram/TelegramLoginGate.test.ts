import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Gate from '../../../src/components/telegram/TelegramLoginGate.svelte';
import { telegramService } from '../../../src/services/telegram.service';
import type { TelegramLoginStage } from '../../../src/types/telegram.type';

let stage: TelegramLoginStage | null;

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status });
}

beforeEach(() => {
	stage = 'awaiting_password';
	telegramService.status.set(null);
	telegramService.lastError.set(null);
	telegramService.optimisticAuthorized.set(false);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.endsWith('/credentials')) return json({ apiId: 1, apiHash: 'h' });
			if (url.endsWith('/auth/password')) {
				return json({ error: 'invalid password', code: 'invalid_password' }, 400);
			}
			if (url.endsWith('/auth/code'))
				return json({ error: 'invalid code', code: 'invalid_code' }, 400);
			if (url.endsWith('/auth/restart')) {
				stage = null;
				return json({ ok: true });
			}
			if (url.endsWith('/auth/qr'))
				return json({ outcome: 'pending', url: 'tg://login?token=x', expiresAt: 1 });
			return json({
				hasCredentials: true,
				connected: true,
				signedIn: false,
				authorized: false,
				loginInProgress: stage,
				codeDelivery: null,
				user: null,
				groups: [],
				activeGroupId: null
			});
		})
	);
});

afterEach(() => {
	telegramService.stop();
	telegramService.stopQrLogin();
	vi.unstubAllGlobals();
});

describe('login errors', () => {
	it('shows a wrong password and lets you type again', async () => {
		const view = render(Gate);
		const input = (await view.findByPlaceholderText('cloud password')) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'nope' } });
		await fireEvent.click(view.getByRole('button', { name: 'Sign in' }));

		await view.findByText('invalid password');
		await waitFor(() => expect(input.disabled).toBe(false));
		expect(input.value).toBe('');
		expect(view.getByPlaceholderText('cloud password')).toBeInTheDocument();
	});

	it('shows a wrong code', async () => {
		stage = 'awaiting_code';
		const view = render(Gate);
		await fireEvent.input(await view.findByPlaceholderText('12345'), {
			target: { value: '00000' }
		});
		await fireEvent.click(view.getByRole('button', { name: 'Verify' }));
		await view.findByText('invalid code');
	});

	it('can start over', async () => {
		const view = render(Gate);
		await fireEvent.click(await view.findByRole('button', { name: 'Start over' }));
		await view.findByPlaceholderText('+1 555 123 4567');
	});
});
