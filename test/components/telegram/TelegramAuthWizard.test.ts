import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TelegramAuthWizard from '../../../src/components/telegram/TelegramAuthWizard.svelte';

describe('TelegramAuthWizard', () => {
	it('renders the phone form when stage is null', () => {
		const { getByPlaceholderText, getByRole } = render(TelegramAuthWizard, {
			props: {
				stage: null,
				onStart: vi.fn(),
				onSubmitCode: vi.fn(),
				onSubmitPassword: vi.fn()
			}
		});
		expect(getByPlaceholderText('+1 555 123 4567')).toBeInTheDocument();
		expect(getByRole('button')).toBeDisabled();
	});

	it('disables the phone submit button while busy', () => {
		const { getByRole } = render(TelegramAuthWizard, {
			props: {
				stage: null,
				busy: true,
				onStart: vi.fn(),
				onSubmitCode: vi.fn(),
				onSubmitPassword: vi.fn()
			}
		});
		const btn = getByRole('button') as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.textContent?.trim()).toBe('Sending…');
	});

	it('calls onStart with the trimmed phone on submit', async () => {
		const onStart = vi.fn();
		const { container, getByPlaceholderText } = render(TelegramAuthWizard, {
			props: {
				stage: null,
				onStart,
				onSubmitCode: vi.fn(),
				onSubmitPassword: vi.fn()
			}
		});
		const input = getByPlaceholderText('+1 555 123 4567') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: '  +123456  ' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onStart).toHaveBeenCalledWith('+123456');
	});

	it('does not invoke onStart for empty phone', async () => {
		const onStart = vi.fn();
		const { container } = render(TelegramAuthWizard, {
			props: {
				stage: null,
				onStart,
				onSubmitCode: vi.fn(),
				onSubmitPassword: vi.fn()
			}
		});
		await fireEvent.submit(container.querySelector('form')!);
		expect(onStart).not.toHaveBeenCalled();
	});

	it('renders the code form when stage = awaiting_code', async () => {
		const onSubmitCode = vi.fn();
		const { getByPlaceholderText, container } = render(TelegramAuthWizard, {
			props: {
				stage: 'awaiting_code',
				onStart: vi.fn(),
				onSubmitCode,
				onSubmitPassword: vi.fn()
			}
		});
		const input = getByPlaceholderText('12345') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: '  98765  ' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmitCode).toHaveBeenCalledWith('98765');
		// code field is cleared
		expect(input.value).toBe('');
	});

	it('does not invoke onSubmitCode for empty code', async () => {
		const onSubmitCode = vi.fn();
		const { container } = render(TelegramAuthWizard, {
			props: {
				stage: 'awaiting_code',
				onStart: vi.fn(),
				onSubmitCode,
				onSubmitPassword: vi.fn()
			}
		});
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmitCode).not.toHaveBeenCalled();
	});

	it('renders the password form when stage = awaiting_password', async () => {
		const onSubmitPassword = vi.fn();
		const { getByPlaceholderText, container } = render(TelegramAuthWizard, {
			props: {
				stage: 'awaiting_password',
				onStart: vi.fn(),
				onSubmitCode: vi.fn(),
				onSubmitPassword
			}
		});
		const input = getByPlaceholderText('cloud password') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'secret' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmitPassword).toHaveBeenCalledWith('secret');
		expect(input.value).toBe('');
	});

	it('does not invoke onSubmitPassword when empty', async () => {
		const onSubmitPassword = vi.fn();
		const { container } = render(TelegramAuthWizard, {
			props: {
				stage: 'awaiting_password',
				onStart: vi.fn(),
				onSubmitCode: vi.fn(),
				onSubmitPassword
			}
		});
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmitPassword).not.toHaveBeenCalled();
	});

	it('shows the busy label on code/password forms', () => {
		const { getByRole, rerender } = render(TelegramAuthWizard, {
			props: {
				stage: 'awaiting_code',
				busy: true,
				onStart: vi.fn(),
				onSubmitCode: vi.fn(),
				onSubmitPassword: vi.fn()
			}
		});
		expect(getByRole('button').textContent?.trim()).toBe('Verifying…');
		rerender({
			stage: 'awaiting_password',
			busy: true,
			onStart: vi.fn(),
			onSubmitCode: vi.fn(),
			onSubmitPassword: vi.fn()
		});
		expect(getByRole('button').textContent?.trim()).toBe('Verifying…');
	});
});
