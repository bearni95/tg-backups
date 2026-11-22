const BRAND = Symbol.for('tgb.InvocationError');

/**
 * `io`, `transport` and `dropped` are connection failures, worth resending.
 * `fatal` is a request that can never succeed as built.
 */
export type InvocationKind = 'rpc' | 'io' | 'transport' | 'dropped' | 'fatal';

/** Every failure of a Telegram call, whatever the MTProto library threw. */
export class InvocationError extends Error {
	readonly [BRAND] = true;

	private constructor(
		readonly kind: InvocationKind,
		message: string,
		readonly code: number = 0,
		/** The error without its number: `FLOOD_WAIT_7` is `FLOOD_WAIT`. */
		readonly rpcName: string = '',
		/** That number. */
		readonly value: number | null = null
	) {
		super(`request error: ${message}`);
		this.name = 'InvocationError';
	}

	static rpc(code: number, text: string, method?: string): InvocationError {
		const digits = text.split(/[^0-9]/).find((part) => part !== '' && Number(part) <= 0xffff_ffff);
		const name = digits === undefined ? text : text.replaceAll(`_${digits}`, '');
		const value = digits === undefined ? null : Number(digits);
		const cause = method ? ` caused by ${method}` : '';
		const suffix = value === null ? '' : ` (value: ${value})`;
		const message = `rpc error ${code}: ${name}${cause}${suffix}`;
		return new InvocationError('rpc', message, code, name, value);
	}

	static io(message: string): InvocationError {
		return new InvocationError('io', message);
	}

	static transport(message: string): InvocationError {
		return new InvocationError('transport', message);
	}

	static dropped(): InvocationError {
		return new InvocationError('dropped', 'dropped (cancelled)');
	}

	static fatal(message: string): InvocationError {
		return new InvocationError('fatal', message);
	}

	static is(error: unknown): error is InvocationError {
		return typeof error === 'object' && error !== null && BRAND in error;
	}

	/** Match the RPC name; `*` is a wildcard at either end. */
	matches(pattern: string): boolean {
		if (this.kind !== 'rpc') return false;
		if (pattern.endsWith('*')) return this.rpcName.startsWith(pattern.slice(0, -1));
		if (pattern.startsWith('*')) return this.rpcName.endsWith(pattern.slice(1));
		return this.rpcName === pattern;
	}
}

export function isRpc(error: unknown, pattern: string): boolean {
	return InvocationError.is(error) && error.matches(pattern);
}

/** Whether resending the same bytes could work. Request-level 4xx errors can't. */
export function isTransient(error: unknown): boolean {
	if (!InvocationError.is(error)) return false;
	if (error.kind !== 'rpc') return error.kind !== 'fatal';
	return (
		error.code === 420 ||
		error.code >= 500 ||
		error.code === -503 ||
		error.rpcName.endsWith('_TIMEOUT')
	);
}
