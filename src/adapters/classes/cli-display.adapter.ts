import { AdapterClass } from '$adapters/classes/adapter.class';
import { formatBytes, formatEta } from '$utils/format';
import { formatTable } from '$utils/table';
import { describeSchedule } from '$utils/cron/schedule';
import type { TrackedPath, TrackedRunOutcome } from '$types/tracked.type';
import type {
	TelegramFile,
	TelegramGroup,
	TelegramGroupInfo,
	TelegramStatus,
	TelegramUser
} from '$types/telegram.type';

/** Turns engine values into the lines the CLI prints. */
export class CliDisplayAdapter extends AdapterClass {
	constructor() {
		super('cli-display');
	}

	userName(user: TelegramUser): string {
		const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
		const handle = user.username ? `@${user.username}` : null;
		return [name, handle].filter(Boolean).join(' ') || `user ${user.id}`;
	}

	createdLabel(createdAt: string): string {
		const date = new Date(createdAt);
		if (Number.isNaN(date.valueOf())) return createdAt;
		// Local time, to the minute: `2026-11-23 14:05`.
		const pad = (value: number) => String(value).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
			date.getHours()
		)}:${pad(date.getMinutes())}`;
	}

	filesTable(files: TelegramFile[]): string {
		if (files.length === 0) return 'No backups yet.';
		const rows = files.map((file) => [
			file.id,
			formatBytes(file.sizeBytes),
			this.createdLabel(file.createdAt),
			file.complete ? '' : 'incomplete',
			file.name
		]);
		return formatTable([['ID', 'SIZE', 'UPLOADED', 'STATE', 'NAME'], ...rows]);
	}

	groupsTable(groups: TelegramGroup[], activeId: string | null = null): string {
		if (groups.length === 0) return 'No groups.';
		const rows = groups.map((group) => [group.id === activeId ? '*' : '', group.id, group.title]);
		return formatTable([['', 'ID', 'TITLE'], ...rows]);
	}

	/** Problems with a group that put its backups at risk. */
	groupWarnings(info: TelegramGroupInfo): string[] {
		const warnings: string[] = [];
		if (info.autoDeleteSeconds) {
			warnings.push(
				`This group deletes messages after ${formatEta(info.autoDeleteSeconds)}, and backups with them. Turn auto-delete off in Telegram before storing anything here.`
			);
		}
		if (info.historyHidden) {
			warnings.push(
				`New members can't see older messages here, so they won't see existing backups. Set "Chat history for new members" to visible in Telegram.`
			);
		}
		return warnings;
	}

	trackedTable(entries: TrackedPath[]): string {
		if (entries.length === 0) return 'Nothing tracked yet.';
		const rows = entries.map((entry) => [
			String(entry.id),
			describeSchedule(entry.schedule),
			entry.lastRunAt
				? `${this.createdLabel(entry.lastRunAt)} ${entry.lastStatus ?? ''}`.trim()
				: 'never',
			entry.groupTitle,
			entry.path
		]);
		return formatTable([['ID', 'SCHEDULE', 'LAST RUN', 'GROUP', 'PATH'], ...rows]);
	}

	/** A label for a tracked path in a menu. */
	trackedChoice(entry: TrackedPath): string {
		return `${entry.path}  (${describeSchedule(entry.schedule)}, ${entry.groupTitle})`;
	}

	/** What a run did. Not ok goes to stderr, with exit code 1. */
	trackedOutcome(outcome: TrackedRunOutcome): { ok: boolean; line: string } {
		const { entry } = outcome;
		switch (outcome.status) {
			case 'uploaded':
				return {
					ok: true,
					line: `${outcome.backupId}  ${outcome.name}  uploaded from ${entry.path}`
				};
			case 'unchanged':
				return {
					ok: true,
					line: `${outcome.backupId}  ${outcome.name}  unchanged, not uploaded again`
				};
			case 'missing':
				return {
					ok: false,
					line: `missing: ${entry.path} was not found; a message saying so was sent to ${entry.groupTitle}`
				};
			case 'failed':
				return { ok: false, line: `failed: ${entry.path}: ${outcome.error}` };
		}
	}

	statusLines(status: TelegramStatus, apiId: number | null): string[] {
		const active = status.groups.find((group) => group.id === status.activeGroupId);
		const account = status.user
			? this.userName(status.user)
			: status.authorized
				? 'signed in'
				: status.loginInProgress
					? 'login in progress'
					: 'not signed in';
		return [
			`credentials  ${apiId === null ? 'not set' : `api_id ${apiId}`}`,
			`account      ${account}`,
			`group        ${active ? `${active.title} (${active.id})` : 'none chosen'}`,
			`groups       ${status.groups.length}`
		];
	}
}

export const cliDisplayAdapter = new CliDisplayAdapter();
