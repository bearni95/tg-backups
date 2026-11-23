import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '$lib/logger';
import { telegramGroupAdapter } from '$adapters/classes/telegram-group.adapter';
import { asObject, parseJson } from '$utils/json/losslessJson';
import type { AccountGroups, SavedGroup } from '$types/telegram-engine.type';
import { groupsPath } from './paths';
import { writePrivateFile } from './session';

function readGroup(value: unknown): SavedGroup | null {
	const group = asObject(value);
	if (!group) return null;
	const { id, title, accessHash } = group;
	if (typeof id !== 'string' || !telegramGroupAdapter.isGroupId(id)) return null;
	if (typeof title !== 'string') return null;
	if (typeof accessHash !== 'string' || !/^-?\d+$/.test(accessHash)) return null;
	return { id, title, accessHash };
}

/**
 * `<data root>/telegram/groups.json`: the groups each account uses and the one
 * selected. Per account, because access hashes are.
 */
export class GroupRegistry {
	private readonly accounts = new Map<number, AccountGroups>();
	private readonly path: string;

	constructor(dataRoot: string) {
		this.path = groupsPath(dataRoot);
		this.load();
	}

	get(userId: number): AccountGroups {
		return this.accounts.get(userId) ?? { activeGroupId: null, groups: [] };
	}

	find(userId: number, id: string): SavedGroup | null {
		return this.get(userId).groups.find((group) => group.id === id) ?? null;
	}

	/** Add or refresh a group and make it the selected one. */
	select(userId: number, group: SavedGroup): void {
		const { groups } = this.get(userId);
		const known = groups.some((saved) => saved.id === group.id);
		this.commit(userId, {
			activeGroupId: group.id,
			groups: known
				? groups.map((saved) => (saved.id === group.id ? group : saved))
				: [...groups, group]
		});
	}

	rename(userId: number, id: string, title: string): void {
		const { activeGroupId, groups } = this.get(userId);
		if (!groups.some((group) => group.id === id && group.title !== title)) return;
		this.commit(userId, {
			activeGroupId,
			groups: groups.map((group) => (group.id === id ? { ...group, title } : group))
		});
	}

	private commit(userId: number, account: AccountGroups): void {
		const next = new Map(this.accounts).set(userId, account);
		mkdirSync(dirname(this.path), { recursive: true });
		writePrivateFile(
			this.path,
			JSON.stringify({ v: 1, accounts: Object.fromEntries(next) }, null, 2)
		);
		this.accounts.set(userId, account);
	}

	private load(): void {
		let text: string;
		try {
			text = readFileSync(this.path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}

		let accounts: Record<string, unknown> | null = null;
		try {
			accounts = asObject(asObject(parseJson(text))?.accounts);
		} catch {
			// Reported below.
		}
		if (!accounts) {
			// Nothing is lost: groups can be picked again from Telegram.
			log.warn(`${this.path} is unreadable; pick the groups again with \`tgb groups use\``);
			return;
		}

		for (const [user, value] of Object.entries(accounts)) {
			const account = asObject(value);
			if (!/^\d+$/.test(user) || !account || !Array.isArray(account.groups)) continue;
			const groups = account.groups
				.map(readGroup)
				.filter((group): group is SavedGroup => group !== null);
			const active = groups.find((group) => group.id === account.activeGroupId);
			this.accounts.set(Number(user), { groups, activeGroupId: active?.id ?? null });
		}
	}
}
