import type { tl } from '@mtcute/node';
import { describeError, log } from '$lib/server/logger';
import { OnceAsync, sleep } from '$lib/server/sync';
import type { PeerRef } from '$types/telegram-server.type';
import { TTL_SECONDS } from './access-cookie';
import { StorageError } from './errors';
import { probeMembership, resolveGroupPeer } from './group';
import { InvocationError } from './invocation-error';
import type { FileSession } from './session';
import type { InvokeOptions, Pool, Transport } from './transport';

const FLOOD_SLEEP_LIMIT_SECONDS = 60;
const IO_RETRY_DELAY_MS = 1_000;
const AUTH_CHECK_TIMEOUT_MS = 10_000;
/** Membership is re-checked with Telegram at most hourly, like the bypass cookie. */
const ACCESS_CACHE_TTL_MS = TTL_SECONDS * 1000;

/**
 * One retry for a short flood wait or a connection blip, none for anything else.
 * Part uploads layer their own retry budget on top.
 */
export function autoRetryDelayMs(error: unknown): number | null {
	if (!InvocationError.is(error)) return null;
	if (error.kind === 'io') return IO_RETRY_DELAY_MS;
	if (error.kind !== 'rpc' || error.code !== 420 || error.value === null) return null;
	return error.value <= FLOOD_SLEEP_LIMIT_SECONDS ? error.value * 1000 : null;
}

/** One signed-in (or signing-in) MTProto client and what is cached per connection. */
export class Connection {
	/** The walk runs once per connection; a failed walk runs again. */
	readonly indexReconciled = new OnceAsync<number>();
	readonly metadataReconciled = new OnceAsync<number>();

	private readonly target = new OnceAsync<PeerRef>();
	private readonly uploadPool = new OnceAsync<Pool>();
	private uploadPoolChoice: Pool = 'main';
	private accessCache: { allowed: boolean; at: number } | null = null;
	private closed = false;

	constructor(
		readonly transport: Transport,
		readonly session: FileSession,
		readonly apiId: number,
		readonly apiHash: string,
		readonly accessGroup: string | null
	) {}

	async invoke<T extends tl.RpcMethod>(
		request: T,
		options?: InvokeOptions
	): Promise<tl.RpcCallReturn[T['_']]> {
		try {
			return await this.transport.invoke(request, options);
		} catch (error) {
			const delay = this.closed ? null : autoRetryDelayMs(error);
			if (delay === null) throw error;
			await sleep(delay);
			return await this.transport.invoke(request, options);
		}
	}

	async isAuthorized(): Promise<boolean> {
		try {
			await this.invoke({ _: 'updates.getState' }, { timeoutMs: AUTH_CHECK_TIMEOUT_MS });
			return true;
		} catch (error) {
			if (InvocationError.is(error) && error.kind === 'rpc' && error.code === 401) return false;
			throw error;
		}
	}

	async getMe(): Promise<tl.TypeUser> {
		const [me] = await this.invoke({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] });
		if (!me) throw StorageError.internal('Telegram returned no profile for this account');
		return me;
	}

	/**
	 * The one shared group every member reads and writes. There is no fallback:
	 * no per-user group and never Saved Messages.
	 */
	async targetPeer(): Promise<PeerRef> {
		const { value } = await this.target.run(async () => {
			const spec = this.accessGroup;
			if (spec === null) {
				throw StorageError.internal(
					'TGB_TELEGRAM_ACCESS_GROUP is not set — it names the Telegram group used as storage'
				);
			}
			const peer = await resolveGroupPeer(this, spec);
			if (!peer) {
				throw StorageError.internal(
					`shared access group ${JSON.stringify(spec)} could not be resolved to a storage peer (is this account a member?)`
				);
			}
			return peer;
		});
		return value;
	}

	/** Throws when Telegram can't say, so the gate stays closed without reporting "denied". */
	async accessAllowed(me: tl.TypeUser): Promise<boolean> {
		if (this.accessGroup === null) return true;
		const cached = this.accessCache;
		if (cached && performance.now() - cached.at < ACCESS_CACHE_TTL_MS) return cached.allowed;

		const allowed = await probeMembership(this, this.accessGroup, me);
		this.accessCache = { allowed, at: performance.now() };
		return allowed;
	}

	recheckAccess(): void {
		this.accessCache = null;
	}

	/** Open the upload connections up front, or settle for the main one. */
	async ensureUploadPool(): Promise<void> {
		const { value } = await this.uploadPool.run(async () => {
			try {
				await this.transport.invoke({ _: 'help.getConfig' }, { pool: 'upload' });
				return 'upload';
			} catch (error) {
				log.warn(
					`no extra upload connections (${describeError(error)}); uploading over the main connection`
				);
				return 'main';
			}
		});
		this.uploadPoolChoice = value;
	}

	get uploadConnection(): Pool {
		return this.uploadPoolChoice;
	}

	async switchHomeDc(id: number): Promise<void> {
		if (this.session.homeDcId === id) return;
		log.info(`login: account lives on DC ${id} (was ${this.session.homeDcId}), switching`);
		await this.transport.changeHomeDc(id);
		this.session.setHomeDc(id);
	}

	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.session.close();
		await this.transport.close();
	}
}
