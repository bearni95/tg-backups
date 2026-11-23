// auth.sendCode and friends are called raw, because the CLI has to show where the
// code went (app, SMS, call, email) and high-level helpers drop that.
import type { tl } from '@mtcute/node';
import { describeError, log } from '$lib/logger';
import { telegramAuthAdapter } from '$adapters/classes/telegram-auth.adapter';
import type { TelegramCodeDelivery } from '$types/telegram.type';
import type { Connection } from './connection';
import { StorageError } from './errors';
import { InvocationError, isRpc } from './invocation-error';

export interface CodeRequest {
	phone: string;
	phoneCodeHash: string;
}

export interface SentCode {
	request: CodeRequest;
	delivery: TelegramCodeDelivery;
}

export type SignInStep =
	| { kind: 'authenticated'; user: tl.TypeUser }
	| { kind: 'password'; password: tl.account.RawPassword };

export type QrStep = { kind: 'pending'; url: string; expiresAt: number } | SignInStep;

export async function requestCode(connection: Connection, phone: string): Promise<SentCode> {
	const request: tl.auth.RawSendCodeRequest = {
		_: 'auth.sendCode',
		phoneNumber: phone,
		apiId: connection.apiId,
		apiHash: connection.apiHash,
		settings: { _: 'codeSettings' }
	};

	let sent: tl.auth.TypeSentCode;
	try {
		sent = await connection.invoke(request);
	} catch (error) {
		if (!InvocationError.is(error) || error.code !== 303) throw error;
		if (error.value === null) {
			throw StorageError.telegram(`${error.rpcName} without a target DC`);
		}
		await connection.switchHomeDc(error.value);
		sent = await connection.invoke(request);
	}
	return codeSent('sent', phone, sent);
}

/** Usually goes out over the next method. The hash can change. */
export async function resendCode(connection: Connection, request: CodeRequest): Promise<SentCode> {
	const sent = await connection.invoke({
		_: 'auth.resendCode',
		phoneNumber: request.phone,
		phoneCodeHash: request.phoneCodeHash
	});
	return codeSent('resent', request.phone, sent);
}

function codeSent(verb: string, phone: string, sent: tl.auth.TypeSentCode): SentCode {
	if (sent._ === 'auth.sentCodeSuccess') {
		throw StorageError.telegram(
			'Telegram reported the login as already complete; restart the sign-in'
		);
	}
	if (sent._ === 'auth.sentCodePaymentRequired') {
		throw StorageError.telegram(
			'Telegram requires a payment before it will send a login code to this number'
		);
	}
	const delivery = telegramAuthAdapter.deliveryFromSentCode(sent);
	log.info(`login code ${verb} via ${delivery.method} (resend via ${delivery.nextMethod})`);
	return { request: { phone, phoneCodeHash: sent.phoneCodeHash }, delivery };
}

export async function submitCode(
	connection: Connection,
	request: CodeRequest,
	code: string
): Promise<SignInStep> {
	let authorization: tl.auth.TypeAuthorization;
	try {
		authorization = await connection.invoke({
			_: 'auth.signIn',
			phoneNumber: request.phone,
			phoneCodeHash: request.phoneCodeHash,
			phoneCode: code
		});
	} catch (error) {
		if (isRpc(error, 'SESSION_PASSWORD_NEEDED')) return passwordRequired(connection);
		if (isRpc(error, 'PHONE_CODE_*')) throw StorageError.invalidCode();
		throw error;
	}
	return authorized(connection, authorization);
}

let lastLoggedQrExpiry = 0;

/**
 * One poll of QR login, for accounts whose codes never arrive. The token is
 * stable until it expires, so the QR doesn't change on every poll.
 */
export async function qrLoginStep(connection: Connection): Promise<QrStep> {
	try {
		let token = await connection.invoke({
			_: 'auth.exportLoginToken',
			apiId: connection.apiId,
			apiHash: connection.apiHash,
			exceptIds: []
		});
		// Approved from an account on another DC: redeem the token there.
		if (token._ === 'auth.loginTokenMigrateTo') {
			await connection.switchHomeDc(token.dcId);
			token = await connection.invoke({ _: 'auth.importLoginToken', token: token.token });
		}

		switch (token._) {
			case 'auth.loginToken': {
				if (lastLoggedQrExpiry !== token.expires) {
					lastLoggedQrExpiry = token.expires;
					log.info(`qr login: showing a new QR (expires at ${token.expires})`);
				}
				const encoded = Buffer.from(token.token).toString('base64url');
				return {
					kind: 'pending',
					url: `tg://login?token=${encoded}`,
					expiresAt: token.expires
				};
			}
			case 'auth.loginTokenSuccess':
				return await authorized(connection, token.authorization);
			case 'auth.loginTokenMigrateTo':
				throw StorageError.telegram('QR login asked to switch data centers twice');
		}
	} catch (error) {
		if (isRpc(error, 'SESSION_PASSWORD_NEEDED')) return passwordRequired(connection);
		throw error;
	}
}

async function passwordRequired(connection: Connection): Promise<SignInStep> {
	return { kind: 'password', password: await connection.invoke({ _: 'account.getPassword' }) };
}

async function authorized(
	connection: Connection,
	authorization: tl.auth.TypeAuthorization
): Promise<SignInStep> {
	if (authorization._ !== 'auth.authorization') {
		throw StorageError.telegram('sign up with the official Telegram app required');
	}
	return { kind: 'authenticated', user: await completeLogin(connection, authorization) };
}

/** Record who signed in, and where updates stand, in the session. */
async function completeLogin(
	connection: Connection,
	authorization: tl.auth.RawAuthorization
): Promise<tl.TypeUser> {
	await connection.transport.notifyLoggedIn(authorization);

	try {
		const { pts, qts, date, seq } = await connection.invoke({ _: 'updates.getState' });
		connection.session.setUpdatesState({ pts, qts, date, seq, channels: [] });
	} catch (error) {
		log.warn(`could not read the update state after login: ${describeError(error)}`);
	}

	const { user } = authorization;
	if (user._ !== 'user' || !user.accessHash) {
		throw StorageError.internal('signed-in user has no peer reference');
	}
	connection.setAccount(user.id);
	connection.session.setSelf({ id: user.id, accessHash: user.accessHash, bot: !!user.bot });
	return user;
}

export async function submitPassword(connection: Connection, input: string): Promise<tl.TypeUser> {
	let authorization: tl.auth.TypeAuthorization;
	try {
		// Fresh each time: an SRP challenge works once.
		const password = await connection.invoke({ _: 'account.getPassword' });
		const srp = await connection.transport.computeSrp(password, input);
		authorization = await connection.invoke({ _: 'auth.checkPassword', password: srp });
	} catch (error) {
		if (isRpc(error, 'PASSWORD_HASH_INVALID')) throw StorageError.invalidPassword();
		throw error;
	}
	if (authorization._ !== 'auth.authorization') {
		throw StorageError.telegram('sign up with the official Telegram app required');
	}
	return completeLogin(connection, authorization);
}

/** Whether Telegram ended the login, leaving nothing to retry the password on. */
export function loginExpired(error: unknown): boolean {
	return InvocationError.is(error) && (error.code === 401 || error.matches('AUTH_RESTART'));
}
