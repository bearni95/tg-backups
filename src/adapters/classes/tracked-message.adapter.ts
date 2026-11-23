import { AdapterClass } from '$adapters/classes/adapter.class';
import { formatBytes } from '$utils/format';
import { describeSchedule } from '$utils/cron/schedule';
import type { TrackedPath } from '$types/tracked.type';

export interface MissingFileContext {
	/** RFC 3339. */
	checkedAt: string;
	host: string;
	/** Why the path couldn't be read, like `ENOENT`. */
	reason: string;
}

/** The text tgb posts to a group about a tracked path. */
export class TrackedMessageAdapter extends AdapterClass {
	constructor() {
		super('tracked-message');
	}

	/** Everything known about a tracked path that wasn't there when its backup was due. */
	missingFile(entry: TrackedPath, context: MissingFileContext): string {
		const never = 'never';
		const lines = [
			`tgb: scheduled backup skipped, the tracked ${entry.kind} was not found`,
			'',
			`Path: ${entry.path}`,
			`Kind: ${entry.kind}`,
			`Reason: ${context.reason}`,
			`Tracked id: ${entry.id}`,
			`Machine: ${context.host}`,
			`Checked at: ${context.checkedAt}`,
			`Schedule: ${entry.schedule} (${describeSchedule(entry.schedule)})`,
			`Group: ${entry.groupTitle} (${entry.groupId})`,
			`Tracked since: ${entry.addedAt}`,
			`Last run: ${entry.lastRunAt ?? never}${entry.lastStatus ? ` (${entry.lastStatus})` : ''}`,
			`Last backup: ${entry.lastBackupAt ?? never}${entry.lastBackupId ? ` (id ${entry.lastBackupId})` : ''}`,
			`Last known size: ${entry.lastSizeBytes === null ? 'unknown' : `${formatBytes(entry.lastSizeBytes)} (${entry.lastSizeBytes} bytes)`}`,
			`Last known modification: ${entry.lastModifiedAt ?? 'unknown'}`
		];
		return lines.join('\n');
	}
}

export const trackedMessageAdapter = new TrackedMessageAdapter();
