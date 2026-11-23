// Marking paths for scheduled backup, and changing or dropping them.
import { resolve } from 'node:path';
import { StorageError } from '$lib/telegram/errors';
import type { TelegramStorage } from '$lib/telegram/storage';
import { parseSchedule } from '$utils/cron/schedule';
import type { TrackedPath } from '$types/tracked.type';
import { inspectTrackable } from './run';
import type { TrackedStore } from './store';

export interface TrackInput {
	path: string;
	/** A preset word or a cron expression. */
	schedule: string;
	/** A group id this account uses; the chosen group when left out. */
	groupId?: string;
}

export function requireSchedule(text: string): string {
	const parsed = parseSchedule(text);
	if (!parsed.ok) throw StorageError.badRequest(parsed.error);
	return parsed.cron;
}

export async function trackPath(
	storage: TelegramStorage,
	store: TrackedStore,
	input: TrackInput
): Promise<TrackedPath> {
	const path = resolve(input.path.trim());
	const schedule = requireSchedule(input.schedule);
	const info = await inspectTrackable(path, storage.dataRoot);
	await storage.requireAuthorized();
	const group = await storage.groups.resolve(input.groupId ?? null);
	return store.add({
		path,
		kind: info.isDirectory() ? 'folder' : 'file',
		groupId: group.id,
		groupTitle: group.title,
		schedule,
		addedAt: new Date().toISOString(),
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastBackupId: null,
		lastBackupAt: null,
		lastSizeBytes: info.isFile() ? info.size : null,
		lastModifiedAt: info.mtime.toISOString()
	});
}

export function reschedule(store: TrackedStore, id: string, schedule: string): TrackedPath {
	return store.update(id, { schedule: requireSchedule(schedule) });
}
