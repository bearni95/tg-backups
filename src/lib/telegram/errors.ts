import { InvocationError } from './invocation-error';

// Survives a second copy of this module, where `instanceof` would not.
const BRAND = Symbol.for('tgb.StorageError');

export type ErrorCode =
	| 'not_authenticated'
	| 'password_required'
	| 'credentials_missing'
	| 'no_login_in_progress'
	| 'login_in_progress_mismatch'
	| 'invalid_code'
	| 'invalid_password'
	| 'bad_request'
	| 'not_found'
	| 'backup_incomplete'
	| 'delete_failed'
	| 'group_required'
	| 'group_unavailable'
	| 'group_not_found'
	| 'upload_aborted'
	| 'file_too_large'
	| 'unsupported_media_type'
	| 'checksum_mismatch'
	| 'rate_limited'
	| 'telegram_error'
	| 'database_error'
	| 'io_error'
	| 'internal';

interface ErrorDetails {
	retryAfterSeconds?: number;
	limitBytes?: number;
	name?: string;
	mime?: string;
}

/** Session-kill errors: the user has to sign in again, not see an internal error. */
const SIGNED_OUT = new Set([
	'AUTH_KEY_UNREGISTERED',
	'AUTH_KEY_INVALID',
	'AUTH_KEY_PERM_EMPTY',
	'SESSION_EXPIRED',
	'SESSION_REVOKED',
	'USER_DEACTIVATED',
	'USER_DEACTIVATED_BAN'
]);

/** The one error the engine throws, with a stable `code` and optional details. */
export class StorageError extends Error {
	readonly [BRAND] = true;

	private constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details: ErrorDetails = {}
	) {
		super(message);
		this.name = 'StorageError';
	}

	static notAuthenticated() {
		return new StorageError('not_authenticated', 'not authenticated');
	}

	static credentialsMissing() {
		return new StorageError('credentials_missing', 'api credentials not configured');
	}

	static loginInProgressMismatch() {
		return new StorageError(
			'login_in_progress_mismatch',
			'login already in progress for a different phone'
		);
	}

	static noLoginInProgress() {
		return new StorageError('no_login_in_progress', 'no login in progress');
	}

	static passwordRequired() {
		return new StorageError('password_required', 'password required');
	}

	static invalidCode() {
		return new StorageError('invalid_code', 'invalid code');
	}

	static invalidPassword() {
		return new StorageError('invalid_password', 'invalid password');
	}

	static fileTooLarge(limitBytes: number) {
		const message = `file too large: ${limitBytes} byte limit`;
		return new StorageError('file_too_large', message, { limitBytes });
	}

	static unsupportedMediaType(name: string, mime: string) {
		const message = `unsupported file type for ${JSON.stringify(name)} (mime=${mime}); only .zip backups are accepted`;
		return new StorageError('unsupported_media_type', message, { name, mime });
	}

	static notFound() {
		return new StorageError('not_found', 'file not found');
	}

	static groupRequired() {
		return new StorageError('group_required', 'create or choose a backup group first');
	}

	static groupNotFound() {
		return new StorageError('group_not_found', 'group not found for this account');
	}

	static groupUnavailable() {
		return new StorageError(
			'group_unavailable',
			'this account no longer has access to that group; choose or create another'
		);
	}

	static deleteFailed(left: number, total: number, cause: unknown) {
		if (cause !== null) {
			const mapped = StorageError.from(cause);
			// These say better what to do.
			if (mapped.code === 'rate_limited' || mapped.code === 'not_authenticated') return mapped;
		}
		const forbidden =
			cause === null ||
			(InvocationError.is(cause) &&
				(cause.matches('MESSAGE_DELETE_FORBIDDEN') || cause.matches('CHAT_ADMIN_REQUIRED')));
		const reason = forbidden
			? 'only the uploader or a group admin can delete them'
			: StorageError.from(cause).message;
		return new StorageError(
			'delete_failed',
			`Telegram did not delete ${left} of ${total} messages, so what is left is still listed: ${reason}`
		);
	}

	static checksumMismatch(expected: string, actual: string, note = '') {
		const message = `checksum mismatch: expected ${expected}, got ${actual}${note}`;
		return new StorageError('checksum_mismatch', message);
	}

	static backupIncomplete() {
		return new StorageError(
			'backup_incomplete',
			'backup is incomplete; upload the same zip again to finish it'
		);
	}

	static uploadAborted() {
		return new StorageError('upload_aborted', 'upload aborted by caller');
	}

	static rateLimited(retryAfterSeconds: number) {
		const message = `rate limited; retry after ${retryAfterSeconds}s`;
		return new StorageError('rate_limited', message, { retryAfterSeconds });
	}

	static telegram(message: string) {
		return new StorageError('telegram_error', `telegram error: ${message}`);
	}

	static database(message: string) {
		return new StorageError('database_error', `database error: ${message}`);
	}

	static io(message: string) {
		return new StorageError('io_error', `io error: ${message}`);
	}

	static badRequest(message: string) {
		return new StorageError('bad_request', `bad request: ${message}`);
	}

	static internal(message: string) {
		return new StorageError('internal', `internal: ${message}`);
	}

	static is(error: unknown): error is StorageError {
		return typeof error === 'object' && error !== null && BRAND in error;
	}

	static from(error: unknown): StorageError {
		if (StorageError.is(error)) return error;
		if (InvocationError.is(error)) return fromInvocation(error);
		if (error instanceof SyntaxError) return StorageError.internal(`json: ${error.message}`);
		if (error instanceof Error) {
			const { code, syscall } = error as NodeJS.ErrnoException;
			if (typeof code === 'string' && code.startsWith('ERR_SQLITE')) {
				return StorageError.database(error.message);
			}
			if (syscall) return StorageError.io(error.message);
			return StorageError.internal(error.message);
		}
		return StorageError.internal(String(error));
	}
}

function fromInvocation(error: InvocationError): StorageError {
	if (error.kind === 'rpc') {
		if (error.rpcName.startsWith('FLOOD_') && error.value !== null) {
			return StorageError.rateLimited(error.value);
		}
		if (SIGNED_OUT.has(error.rpcName)) return StorageError.notAuthenticated();
	}
	return StorageError.telegram(error.message);
}
