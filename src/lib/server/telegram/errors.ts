import { InvocationError } from './invocation-error';

// Survives dev-server reloads, where `instanceof` would not.
const BRAND = Symbol.for('tgb.StorageError');

const STATUS = {
	not_authenticated: 401,
	password_required: 401,
	credentials_missing: 400,
	no_login_in_progress: 400,
	login_in_progress_mismatch: 400,
	invalid_code: 400,
	invalid_password: 400,
	bad_request: 400,
	not_found: 404,
	backup_incomplete: 409,
	group_required: 409,
	group_unavailable: 409,
	group_not_found: 404,
	upload_aborted: 409,
	file_too_large: 413,
	unsupported_media_type: 415,
	checksum_mismatch: 422,
	rate_limited: 429,
	telegram_error: 500,
	database_error: 500,
	io_error: 500,
	internal: 500
} as const;

export type ErrorCode = keyof typeof STATUS;

interface ErrorDetails {
	retryAfterSeconds?: number;
	limitBytes?: number;
	name?: string;
	mime?: string;
}

/** Session-kill errors: the UI has to ask for a new sign-in, not show a server error. */
const SIGNED_OUT = new Set([
	'AUTH_KEY_UNREGISTERED',
	'AUTH_KEY_INVALID',
	'AUTH_KEY_PERM_EMPTY',
	'SESSION_EXPIRED',
	'SESSION_REVOKED',
	'USER_DEACTIVATED',
	'USER_DEACTIVATED_BAN'
]);

/** The one error the API returns, as `{ error, code, …details }`. */
export class StorageError extends Error {
	readonly [BRAND] = true;
	readonly status: number;

	private constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details: ErrorDetails = {},
		status?: number
	) {
		super(message);
		this.name = 'StorageError';
		this.status = status ?? STATUS[code];
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

	static checksumMismatch(expected: string, actual: string) {
		const message = `checksum mismatch: expected ${expected}, got ${actual}`;
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

	/** `status` is for requests rejected before they reach a handler (415, 422). */
	static badRequest(message: string, status?: number) {
		return new StorageError('bad_request', `bad request: ${message}`, {}, status);
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

	toJSON() {
		return { error: this.message, code: this.code, ...this.details };
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
