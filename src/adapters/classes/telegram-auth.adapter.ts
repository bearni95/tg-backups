import type { tl } from '@mtcute/node';
import { AdapterClass } from '$adapters/classes/adapter.class';
import type { TelegramCodeDelivery, TelegramCodeMethod, TelegramUser } from '$types/telegram.type';

const SENT_METHODS: Record<tl.auth.TypeSentCodeType['_'], TelegramCodeMethod> = {
	'auth.sentCodeTypeApp': 'app',
	'auth.sentCodeTypeSms': 'sms',
	'auth.sentCodeTypeCall': 'call',
	'auth.sentCodeTypeFlashCall': 'flash_call',
	'auth.sentCodeTypeMissedCall': 'missed_call',
	'auth.sentCodeTypeEmailCode': 'email',
	'auth.sentCodeTypeSetUpEmailRequired': 'setup_email_required',
	'auth.sentCodeTypeFragmentSms': 'fragment_sms',
	'auth.sentCodeTypeFirebaseSms': 'firebase_sms',
	'auth.sentCodeTypeSmsWord': 'sms_word',
	'auth.sentCodeTypeSmsPhrase': 'sms_phrase'
};

const NEXT_METHODS: Record<tl.auth.TypeCodeType['_'], TelegramCodeMethod> = {
	'auth.codeTypeSms': 'sms',
	'auth.codeTypeCall': 'call',
	'auth.codeTypeFlashCall': 'flash_call',
	'auth.codeTypeMissedCall': 'missed_call',
	'auth.codeTypeFragmentSms': 'fragment_sms'
};

export class TelegramAuthAdapter extends AdapterClass {
	constructor() {
		super('telegram-auth');
	}

	/** Where a login code went, so the UI can say where to look. */
	deliveryFromSentCode(sent: tl.auth.RawSentCode): TelegramCodeDelivery {
		return {
			method: SENT_METHODS[sent.type._],
			length: 'length' in sent.type ? (sent.type.length ?? null) : null,
			emailPattern: sent.type._ === 'auth.sentCodeTypeEmailCode' ? sent.type.emailPattern : null,
			nextMethod: sent.nextType ? NEXT_METHODS[sent.nextType._] : null,
			timeoutSecs: sent.timeout ?? null
		};
	}

	userFromTl(user: tl.TypeUser): TelegramUser {
		const full = user._ === 'user' ? user : null;
		return {
			id: user.id,
			firstName: full?.firstName ?? null,
			lastName: full?.lastName || null,
			username: full?.username ?? null,
			phone: full?.phone ?? null
		};
	}
}

export const telegramAuthAdapter = new TelegramAuthAdapter();
