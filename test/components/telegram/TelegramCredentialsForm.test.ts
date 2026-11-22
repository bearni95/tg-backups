import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TelegramCredentialsForm from '../../../src/components/telegram/TelegramCredentialsForm.svelte';

describe('TelegramCredentialsForm', () => {
	it('renders inputs with initial values', () => {
		const { getByPlaceholderText } = render(TelegramCredentialsForm, {
			props: {
				initialApiId: '999',
				initialApiHash: 'abc',
				onSubmit: vi.fn()
			}
		});
		const id = getByPlaceholderText('123456') as HTMLInputElement;
		const hash = getByPlaceholderText('0123456789abcdef0123456789abcdef') as HTMLInputElement;
		expect(id.value).toBe('999');
		expect(hash.value).toBe('abc');
	});

	it('keeps submit disabled when fields are invalid', () => {
		const { getByRole } = render(TelegramCredentialsForm, {
			props: { onSubmit: vi.fn() }
		});
		expect((getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});

	it('disables submit and shows "Saving…" when busy', () => {
		const { getByRole } = render(TelegramCredentialsForm, {
			props: {
				initialApiId: '1',
				initialApiHash: 'h',
				busy: true,
				onSubmit: vi.fn()
			}
		});
		const btn = getByRole('button') as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.textContent?.trim()).toBe('Saving…');
	});

	it('submits the parsed api id + trimmed hash', async () => {
		const onSubmit = vi.fn();
		const { container, getByPlaceholderText } = render(TelegramCredentialsForm, {
			props: {
				initialApiId: '7',
				initialApiHash: 'hash',
				onSubmit
			}
		});
		const idInput = getByPlaceholderText('123456') as HTMLInputElement;
		await fireEvent.input(idInput, { target: { value: '42' } });
		const hashInput = getByPlaceholderText('0123456789abcdef0123456789abcdef') as HTMLInputElement;
		await fireEvent.input(hashInput, { target: { value: '  myhash  ' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).toHaveBeenCalledWith(42, 'myhash');
	});

	it('does not submit when invalid (api id NaN)', async () => {
		const onSubmit = vi.fn();
		const { container, getByPlaceholderText } = render(TelegramCredentialsForm, {
			props: {
				initialApiId: '',
				initialApiHash: 'hash',
				onSubmit
			}
		});
		const idInput = getByPlaceholderText('123456') as HTMLInputElement;
		await fireEvent.input(idInput, { target: { value: 'abc' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('does not submit when api id is zero/negative', async () => {
		const onSubmit = vi.fn();
		const { container, getByPlaceholderText } = render(TelegramCredentialsForm, {
			props: { initialApiHash: 'h', onSubmit }
		});
		const idInput = getByPlaceholderText('123456') as HTMLInputElement;
		await fireEvent.input(idInput, { target: { value: '-5' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('does not submit when api hash is whitespace', async () => {
		const onSubmit = vi.fn();
		const { container, getByPlaceholderText } = render(TelegramCredentialsForm, {
			props: { initialApiId: '7', onSubmit }
		});
		const hashInput = getByPlaceholderText('0123456789abcdef0123456789abcdef') as HTMLInputElement;
		await fireEvent.input(hashInput, { target: { value: '   ' } });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
