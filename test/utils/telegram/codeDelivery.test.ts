import { describe, it, expect } from 'vitest';
import { codeMethodLabel, describeCodeDelivery } from '../../../src/utils/telegram/codeDelivery';
import type { TelegramCodeDelivery } from '../../../src/types/telegram.type';

const delivery = (overrides: Partial<TelegramCodeDelivery>): TelegramCodeDelivery => ({
	method: 'app',
	length: 5,
	emailPattern: null,
	nextMethod: null,
	timeoutSecs: null,
	...overrides
});

describe('describeCodeDelivery', () => {
	it('falls back to a generic prompt without delivery info', () => {
		expect(describeCodeDelivery(null)).toBe('Enter the code');
	});

	it('points app deliveries at the Telegram app', () => {
		expect(describeCodeDelivery(delivery({ method: 'app' }))).toBe(
			'Code sent to your Telegram app'
		);
	});

	it('names the masked email address', () => {
		expect(
			describeCodeDelivery(delivery({ method: 'email', length: 6, emailPattern: 'b***@gmail.com' }))
		).toBe('Code sent to b***@gmail.com');
	});

	it('names the method for other deliveries', () => {
		expect(describeCodeDelivery(delivery({ method: 'sms', length: null }))).toBe(
			'Code sent via SMS'
		);
	});
});

describe('codeMethodLabel', () => {
	it('labels resend methods', () => {
		expect(codeMethodLabel('sms')).toBe('SMS');
		expect(codeMethodLabel('call')).toBe('phone call');
	});
});
