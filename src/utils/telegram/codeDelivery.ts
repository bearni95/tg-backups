import type { TelegramCodeDelivery, TelegramCodeMethod } from '$types/telegram.type';

const METHOD_LABELS: Record<TelegramCodeMethod, string> = {
	app: 'Telegram app',
	sms: 'SMS',
	call: 'phone call',
	flash_call: 'flash call',
	missed_call: 'missed call',
	email: 'email',
	setup_email_required: 'email',
	fragment_sms: 'Fragment SMS',
	firebase_sms: 'SMS',
	sms_word: 'SMS',
	sms_phrase: 'SMS'
};

/** Short name for a delivery method, e.g. for a "Resend via SMS" button. */
export function codeMethodLabel(method: TelegramCodeMethod): string {
	return METHOD_LABELS[method];
}

/** One short line telling the user where the login code went. */
export function describeCodeDelivery(delivery: TelegramCodeDelivery | null): string {
	if (!delivery) return 'Enter the code';
	switch (delivery.method) {
		case 'app':
			return 'Code sent to your Telegram app';
		case 'flash_call':
		case 'missed_call':
			return 'Enter the last digits of the calling number';
		case 'email':
			return `Code sent to ${delivery.emailPattern ?? 'your email'}`;
		case 'setup_email_required':
			return 'Set a login email in Telegram first';
		default:
			return `Code sent via ${METHOD_LABELS[delivery.method]}`;
	}
}
