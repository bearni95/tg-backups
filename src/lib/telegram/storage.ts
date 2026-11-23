import { mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { describeError, log } from '$lib/logger';
import { Semaphore } from '$lib/sync';
import { parseJson } from '$utils/json/losslessJson';
import type { TelegramCredentials } from '$types/telegram.type';
import type { TransferPayload } from '$types/telegram-engine.type';
import {
	clearCredentials,
	credentialsFromBuild,
	credentialsFromEnv,
	loadCredentials,
	saveCredentials
} from './config';
import { Connection } from './connection';
import { StorageError } from './errors';
import { Groups } from './groups';
import { LoginFlow } from './login';
import { sessionPath, telegramDir } from './paths';
import { FileSession, writePrivateFile } from './session';
import { createTransport, type TransportFactory } from './transport';
import { UploadRegistry } from './uploads';

export interface StorageOptions {
	dataRoot: string;
	createTransport?: TransportFactory;
}

export interface TransferImport {
	v?: number;
	kind?: string;
	credentials?: TelegramCredentials;
	session?: unknown;
}

function requireCredentials({ apiId, apiHash }: TelegramCredentials, prefix = ''): void {
	if (apiId === 0 || apiHash.trim() === '') {
		throw StorageError.badRequest(`${prefix}apiId and ${prefix}apiHash are required`);
	}
}

/** The engine of one `tgb` run: one MTProto client, one login at a time, any number of groups. */
export class TelegramStorage {
	readonly groups: Groups;
	readonly uploads: UploadRegistry;
	readonly login: LoginFlow;

	private connection: Connection | null = null;
	// Swapping the client is serialised, or two callers would both leave one running.
	private readonly lifecycle = new Semaphore();

	private constructor(
		readonly dataRoot: string,
		private storedCredentials: TelegramCredentials | null,
		private readonly transportFactory: TransportFactory
	) {
		this.groups = new Groups(dataRoot, () => this.requireClient());
		this.uploads = new UploadRegistry((job, request) =>
			job.group.files.uploadLocalFile(job.path, request, { dataRoot, within: job.within })
		);
		this.login = new LoginFlow(() => this.requireClient());
	}

	/** Never touches the network. */
	static async init(options: StorageOptions): Promise<TelegramStorage> {
		const { dataRoot } = options;
		mkdirSync(telegramDir(dataRoot), { recursive: true });

		const credentials =
			(await loadCredentials(dataRoot)) ?? credentialsFromEnv() ?? credentialsFromBuild();
		const storage = new TelegramStorage(
			dataRoot,
			credentials,
			options.createTransport ?? createTransport
		);
		storage.tryConnect('boot');
		return storage;
	}

	get current(): Connection | null {
		return this.connection;
	}

	get credentials(): TelegramCredentials | null {
		return this.storedCredentials;
	}

	/** For login: no client means no credentials yet. */
	requireClient(): Connection {
		if (!this.connection) throw StorageError.credentialsMissing();
		return this.connection;
	}

	async requireAuthorized(): Promise<void> {
		if (!(await this.requireClient().isAuthorized())) throw StorageError.notAuthenticated();
	}

	async setCredentials(credentials: TelegramCredentials): Promise<void> {
		requireCredentials(credentials);
		await this.lifecycle.run(async () => {
			await saveCredentials(this.dataRoot, credentials);
			await this.disconnect();
			this.connection = this.connect(credentials);
			this.storedCredentials = credentials;
		});
	}

	async deleteCredentials(): Promise<void> {
		await this.lifecycle.run(async () => {
			await this.disconnect();
			this.storedCredentials = null;
			await clearCredentials(this.dataRoot);
			await this.wipeSession();
		});
	}

	/** The way out of a login that can't be finished, like a forgotten 2FA password. */
	async restartLogin(): Promise<void> {
		await this.lifecycle.run(async () => {
			if ((await this.login.progress()).stage === null) throw StorageError.noLoginInProgress();
			// A login that did get through keeps its session.
			if (await this.connection?.isAuthorized().catch(() => false)) {
				await this.login.reset();
				return;
			}
			await this.disconnect();
			await this.wipeSession();
			this.tryConnect('login restart');
		});
	}

	async logout(): Promise<void> {
		await this.lifecycle.run(async () => {
			try {
				// Best effort: the local session is wiped either way.
				await this.connection?.invoke({ _: 'auth.logOut' });
			} catch (error) {
				log.warn(`sign out failed: ${describeError(error)}`);
			}
			await this.disconnect();
			await this.wipeSession();
			this.groups.clearIndexes();
			// So the next login doesn't ask for the credentials again.
			this.tryConnect('logout');
		});
	}

	/** What another machine needs to skip setup. `full` includes the session: a secret. */
	async exportTransfer(scope: string): Promise<TransferPayload> {
		if (scope !== 'credentials' && scope !== 'full') {
			throw StorageError.badRequest(`scope must be 'credentials' or 'full', got '${scope}'`);
		}
		if (!this.storedCredentials) throw StorageError.credentialsMissing();
		return {
			v: 1,
			kind: 'tgb-telegram-transfer',
			scope,
			credentials: this.storedCredentials,
			session: scope === 'full' ? await this.readSession() : undefined
		};
	}

	async importTransfer({ v, kind, credentials, session }: TransferImport): Promise<void> {
		if (kind !== undefined && kind !== 'tgb-telegram-transfer') {
			throw StorageError.badRequest(`unknown transfer kind '${kind}'`);
		}
		if (v !== undefined && v !== 1) {
			throw StorageError.badRequest(`unsupported transfer version ${v}`);
		}
		if (!credentials && session === undefined) {
			throw StorageError.badRequest('transfer payload must include credentials or session');
		}
		// Before anything is torn down: a bad payload mustn't cost the current session.
		if (credentials) requireCredentials(credentials, 'credentials.');

		await this.lifecycle.run(async () => {
			// Before the write, or the old client's saves would trample it.
			await this.disconnect();
			if (session !== undefined) {
				mkdirSync(telegramDir(this.dataRoot), { recursive: true });
				writePrivateFile(sessionPath(this.dataRoot), JSON.stringify(session));
			}
			if (credentials) {
				await saveCredentials(this.dataRoot, credentials);
				this.storedCredentials = credentials;
			}
			this.tryConnect('transfer');
		});
	}

	async close(): Promise<void> {
		await this.connection?.shutdown();
		this.connection = null;
		this.groups.close();
	}

	private connect({ apiId, apiHash }: TelegramCredentials): Connection {
		const session = FileSession.open(sessionPath(this.dataRoot));
		const transport = this.transportFactory(session, apiId, apiHash);
		return new Connection(transport, session, apiId, apiHash);
	}

	private tryConnect(when: string): void {
		if (!this.storedCredentials) return;
		try {
			this.connection = this.connect(this.storedCredentials);
		} catch (error) {
			log.warn(`${when} reconnect failed: ${describeError(error)}`);
		}
	}

	private async disconnect(): Promise<void> {
		const previous = this.connection;
		this.connection = null;
		await previous?.shutdown();
		await this.login.reset();
	}

	private async wipeSession(): Promise<void> {
		try {
			await rm(sessionPath(this.dataRoot), { force: true });
		} catch (error) {
			log.warn(`could not delete the session: ${describeError(error)}`);
		}
	}

	private async readSession(): Promise<unknown> {
		try {
			const text = await readFile(sessionPath(this.dataRoot), 'utf8');
			return text ? parseJson(text) : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				// Not the error itself: a JSON error quotes the session.
				log.warn('session file could not be read as JSON; skipping export');
			}
			return undefined;
		}
	}
}
