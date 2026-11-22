import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Long } from '@mtcute/node';
import { describeError, log } from '$lib/server/logger';
import { Semaphore } from '$lib/server/sync';
import { telegramGroupAdapter } from '$adapters/classes/telegram-group.adapter';
import { GROUP_PREFIX, groupName } from '$utils/telegram/groupTitle';
import type { TelegramGroup, TelegramGroupInfo } from '$types/telegram.type';
import type { SavedGroup } from '$types/telegram-server.type';
import { BackupGroup } from './backup-group';
import type { Connection } from './connection';
import { IndexDb } from './db';
import { StorageError } from './errors';
import {
	configureNewGroup,
	createGroup,
	listCandidateGroups,
	MAX_TITLE_LENGTH
} from './group-admin';
import { GroupRegistry } from './group-registry';
import { groupIndexPath, groupsDir } from './paths';

/** Creating, choosing and opening the groups backups are stored in. */
export class Groups {
	private readonly registry: GroupRegistry;
	private readonly indexes = new Map<string, IndexDb>();
	// Per connection: a new client starts with no peers or finished walks.
	private readonly open = new WeakMap<Connection, Map<string, BackupGroup>>();
	private readonly creating = new Semaphore();

	constructor(
		private readonly dataRoot: string,
		private readonly connection: () => Connection
	) {
		this.registry = new GroupRegistry(dataRoot);
	}

	/** For the status poll, so no network. */
	overview(userId: number): { groups: TelegramGroup[]; activeGroupId: string | null } {
		const { groups, activeGroupId } = this.registry.get(userId);
		return { groups: groups.map((group) => telegramGroupAdapter.toApi(group)), activeGroupId };
	}

	async create(rawTitle: string): Promise<TelegramGroup> {
		const name = groupName(rawTitle);
		if (name === '') throw StorageError.badRequest('group name is required');
		const title = `${GROUP_PREFIX}${name}`;
		if ([...title].length > MAX_TITLE_LENGTH) {
			throw StorageError.badRequest(
				`group name is longer than ${MAX_TITLE_LENGTH} characters, ${GROUP_PREFIX} included`
			);
		}

		return this.creating.run(async () => {
			const connection = this.connection();
			const userId = await connection.account();
			const saved = await createGroup(connection, title);
			// Saved before the setup, so a failure there can't lose track of the group.
			this.registry.select(userId, saved);
			await configureNewGroup(connection, telegramGroupAdapter.toPeer(saved, Long.fromString));
			log.info(`created and selected the group ${saved.id}`);
			return telegramGroupAdapter.toApi(saved);
		});
	}

	async available(): Promise<TelegramGroup[]> {
		const groups = await listCandidateGroups(this.connection());
		return groups.map((group) => telegramGroupAdapter.toApi(group));
	}

	/** One already in use, whatever its title, or any from {@link available}. */
	async select(id: string): Promise<TelegramGroup> {
		const connection = this.connection();
		const userId = await connection.account();
		const saved =
			this.registry.find(userId, id) ??
			(await listCandidateGroups(connection)).find((group) => group.id === id);
		if (!saved) throw StorageError.groupNotFound();

		const { title } = await this.backupGroup(connection, userId, saved).inspect();
		this.registry.select(userId, { ...saved, title });
		return { id, title };
	}

	async info(id: string): Promise<TelegramGroupInfo> {
		const connection = this.connection();
		const userId = await connection.account();
		const saved = this.registry.find(userId, id);
		if (!saved) throw StorageError.groupNotFound();

		const details = await this.backupGroup(connection, userId, saved).inspect();
		this.registry.rename(userId, id, details.title);
		return { id, ...details };
	}

	/** The group a request works on: the one it names, else the selected one. */
	async resolve(id: string | null): Promise<BackupGroup> {
		const connection = this.connection();
		const userId = await connection.account();
		const wanted = id ?? this.registry.get(userId).activeGroupId;
		if (wanted === null) throw StorageError.groupRequired();

		const saved = this.registry.find(userId, wanted);
		if (!saved) throw StorageError.groupNotFound();
		const group = this.backupGroup(connection, userId, saved);
		await group.ensureMember();
		return group;
	}

	/** Logout empties every index. The group choices stay, per account. */
	clearIndexes(): void {
		for (const path of this.indexFiles()) {
			try {
				this.index(path).clearAll();
			} catch (error) {
				log.warn(`could not clear ${path}: ${describeError(error)}`);
			}
		}
	}

	close(): void {
		for (const index of this.indexes.values()) index.close();
		this.indexes.clear();
	}

	private backupGroup(connection: Connection, userId: number, saved: SavedGroup): BackupGroup {
		let open = this.open.get(connection);
		if (!open) {
			open = new Map();
			this.open.set(connection, open);
		}
		const key = `${userId}/${saved.id}`;
		let group = open.get(key);
		if (!group) {
			const peer = telegramGroupAdapter.toPeer(saved, Long.fromString);
			const db = this.index(groupIndexPath(this.dataRoot, userId, saved.id));
			group = new BackupGroup(saved.id, saved.title, peer, userId, connection, db);
			open.set(key, group);
		}
		return group;
	}

	private index(path: string): IndexDb {
		let index = this.indexes.get(path);
		if (!index) {
			mkdirSync(dirname(path), { recursive: true });
			index = new IndexDb(path);
			this.indexes.set(path, index);
		}
		return index;
	}

	private indexFiles(): string[] {
		const root = groupsDir(this.dataRoot);
		try {
			return readdirSync(root, { recursive: true, encoding: 'utf8' })
				.filter((file) => file.endsWith('.sqlite'))
				.map((file) => join(root, file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}
}
