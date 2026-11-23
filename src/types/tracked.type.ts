import type { ID } from '$types/core.type';

/** How the last scheduled run of a tracked path ended. */
export type TrackedRunStatus = 'uploaded' | 'unchanged' | 'missing' | 'failed';

/** A local file or folder backed up to a group on a cron schedule. */
export interface TrackedPath {
	id: ID;
	/** Absolute. */
	path: string;
	kind: 'file' | 'folder';
	groupId: string;
	groupTitle: string;
	/** A five-field cron expression, or a macro like `@daily`. */
	schedule: string;
	/** RFC 3339. */
	addedAt: string;
	lastRunAt: string | null;
	lastStatus: TrackedRunStatus | null;
	lastError: string | null;
	/** The backup the last upload made, or found unchanged. */
	lastBackupId: string | null;
	lastBackupAt: string | null;
	/** What the path looked like the last time it was found. */
	lastSizeBytes: number | null;
	lastModifiedAt: string | null;
}

/** What a run did, for the CLI to print. */
export type TrackedRunOutcome =
	| { status: 'uploaded'; entry: TrackedPath; backupId: string; name: string }
	| { status: 'unchanged'; entry: TrackedPath; backupId: string; name: string }
	| { status: 'missing'; entry: TrackedPath }
	| { status: 'failed'; entry: TrackedPath; error: string };
