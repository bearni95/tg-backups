import { arch, release, type } from 'node:os';
import {
	BaseTelegramClient,
	MemoryStorage,
	MtArgumentError,
	MtSecurityError,
	MtUnsupportedError,
	type ITelegramStorageProvider,
	type mtp,
	type tl
} from '@mtcute/node';
import { defaultProductionFallbackDcs, parseBasicDcOption } from '@mtcute/node/utils.js';
import { APP_VERSION } from '$lib/build-info';
import { describeError, log } from '$lib/logger';
import { InvocationError } from './invocation-error';
import type { FileSession } from './session';

export type Pool = 'main' | 'upload' | 'download';

export interface InvokeOptions {
	/** Defaults to the home DC. */
	dcId?: number;
	pool?: Pool;
	timeoutMs?: number;
}

/**
 * The seam to Telegram. Everything above it speaks raw TL, so tests put a fake
 * group here. Failures are always an {@link InvocationError}.
 */
export interface Transport {
	invoke<T extends tl.RpcMethod>(
		request: T,
		options?: InvokeOptions
	): Promise<tl.RpcCallReturn[T['_']]>;
	changeHomeDc(id: number): Promise<void>;
	computeSrp(password: tl.account.RawPassword, input: string): Promise<tl.RawInputCheckPasswordSRP>;
	notifyLoggedIn(authorization: tl.auth.RawAuthorization): Promise<void>;
	close(): Promise<void>;
}

export type TransportFactory = (session: FileSession, apiId: number, apiHash: string) => Transport;

/** Extra connections for `saveBigFilePart`: one connection caps upload throughput. */
export const UPLOAD_CONNECTIONS = 4;

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const HOME_DC_KEY = 'dc_main';
const LOG_LEVEL_WARN = 2;

/** mtcute storage that keeps keys and home DC in the session file and the rest in memory. */
export function sessionStorage(session: FileSession): ITelegramStorageProvider {
	const memory = new MemoryStorage();
	return {
		driver: memory.driver,
		peers: memory.peers,
		refMessages: memory.refMessages,
		kv: {
			get: (key) => memory.kv.get(key),
			delete: (key) => memory.kv.delete(key),
			deleteAll: () => memory.kv.deleteAll(),
			set: (key, value) => {
				memory.kv.set(key, value);
				if (key !== HOME_DC_KEY) return;
				const dc = parseBasicDcOption(value);
				if (dc) session.setHomeDc(dc.id, { ip: dc.ipAddress, port: dc.port });
			}
		},
		authKeys: {
			get: (dc) => session.authKey(dc),
			set: (dc, key) => session.setAuthKey(dc, key),
			getTemp: (dc, index, now) => memory.authKeys.getTemp(dc, index, now),
			setTemp: (dc, index, key, expires) => memory.authKeys.setTemp(dc, index, key, expires),
			deleteByDc: (dc) => {
				memory.authKeys.deleteByDc(dc);
				session.setAuthKey(dc, null);
			},
			deleteAll: () => memory.authKeys.deleteAll()
		}
	};
}

function isRpcFailure(result: unknown): result is mtp.RawMt_rpc_error {
	return (result as { _?: unknown } | null)?._ === 'mt_rpc_error';
}

export function toInvocationError(error: unknown): InvocationError {
	if (InvocationError.is(error)) return error;
	if (error instanceof MtArgumentError || error instanceof MtUnsupportedError) {
		return InvocationError.fatal(error.message);
	}
	if (error instanceof MtSecurityError) return InvocationError.transport(error.message);
	return InvocationError.io(describeError(error));
}

export class MtcuteTransport implements Transport {
	private readonly client: BaseTelegramClient;
	private readonly stop = new AbortController();

	/** Opens no sockets: the first call connects, so boot works offline. */
	constructor(session: FileSession, apiId: number, apiHash: string) {
		const home = session.dcOption(session.homeDcId);
		const [ipAddress, port] = home?.ipv4.split(':') ?? [];
		const dc = { id: session.homeDcId, ipAddress, port: Number(port) };

		this.client = new BaseTelegramClient({
			apiId,
			apiHash,
			storage: sessionStorage(session),
			// Its exit hook would take over SIGINT, and there is nothing to flush.
			storageOptions: { cleanup: false },
			...(home && ipAddress !== '0.0.0.0'
				? { defaultDcs: { main: dc, media: dc }, fallbackDcs: defaultProductionFallbackDcs }
				: {}),
			disableUpdates: true,
			updates: false,
			logLevel: LOG_LEVEL_WARN,
			initConnectionOptions: {
				deviceModel: `${type()} ${arch()}`,
				systemVersion: release(),
				appVersion: APP_VERSION
			},
			network: {
				// No middlewares: theirs retry server errors forever and sleep through
				// floods. Retrying is decided in connection.ts and upload.ts.
				middlewares: [],
				connectionCount: (kind) => (kind === 'upload' ? UPLOAD_CONNECTIONS : 1)
			}
		});
		this.client.onError.add((error) => log.warn(`mtproto: ${error.message}`));
	}

	invoke<T extends tl.RpcMethod>(
		request: T,
		{ dcId, pool = 'main', timeoutMs = DEFAULT_TIMEOUT_MS }: InvokeOptions = {}
	): Promise<tl.RpcCallReturn[T['_']]> {
		return this.bounded(request._, timeoutMs, async (abortSignal) => {
			await this.client.connect();
			// Not client.call: its RpcError rewrites FLOOD_WAIT_7 as FLOOD_WAIT_%d, losing
			// the number that retries and DC migrations need.
			const result: unknown = await this.client.mt.call(request as never, {
				dcId,
				kind: pool,
				abortSignal
			});
			if (isRpcFailure(result)) {
				throw InvocationError.rpc(result.errorCode, result.errorMessage, request._);
			}
			return result as tl.RpcCallReturn[T['_']];
		});
	}

	changeHomeDc(id: number): Promise<void> {
		return this.bounded('changePrimaryDc', DEFAULT_TIMEOUT_MS, () =>
			this.client.changePrimaryDc(id)
		);
	}

	async computeSrp(
		password: tl.account.RawPassword,
		input: string
	): Promise<tl.RawInputCheckPasswordSRP> {
		try {
			return await this.client.computeSrpParams(password, input);
		} catch (error) {
			throw toInvocationError(error);
		}
	}

	async notifyLoggedIn(authorization: tl.auth.RawAuthorization): Promise<void> {
		await this.client.notifyLoggedIn(authorization);
	}

	async close(): Promise<void> {
		if (this.stop.signal.aborted) return;
		this.stop.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.client.destroy().catch((error) => log.warn(`mtproto shutdown: ${describeError(error)}`)),
			new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)))
		]);
		clearTimeout(timer);
	}

	/**
	 * mtcute queues calls until it can reconnect and may never settle them after
	 * shutdown, which would hang /status offline and pin the upload queue on logout.
	 */
	private bounded<T>(
		method: string,
		timeoutMs: number,
		task: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.stop.signal.aborted) return reject(InvocationError.dropped());

			const cancel = new AbortController();
			let settled = false;
			const settle = (finish: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.stop.signal.removeEventListener('abort', onStop);
				finish();
			};
			const onStop = () =>
				settle(() => {
					reject(InvocationError.dropped());
					cancel.abort();
				});
			const timer = setTimeout(
				() =>
					settle(() => {
						reject(InvocationError.io(`${method} timed out after ${timeoutMs} ms`));
						cancel.abort();
					}),
				timeoutMs
			);
			this.stop.signal.addEventListener('abort', onStop, { once: true });

			task(cancel.signal).then(
				(value) => settle(() => resolve(value)),
				(error: unknown) => settle(() => reject(toInvocationError(error)))
			);
		});
	}
}

export const createTransport: TransportFactory = (session, apiId, apiHash) =>
	new MtcuteTransport(session, apiId, apiHash);
