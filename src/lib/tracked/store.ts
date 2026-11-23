// `<data root>/tracked.json`: the paths backed up on a schedule.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from '$lib/telegram/errors';
import type { TrackedPath } from '$types/tracked.type';

const VERSION = 1;

export function trackedPath(dataRoot: string): string {
	return join(dataRoot, 'tracked.json');
}

/** Zips made from files and folders wait here while they upload. */
export function stagingDir(dataRoot: string): string {
	return join(dataRoot, 'staging');
}

export function cronLogPath(dataRoot: string): string {
	return join(dataRoot, 'cron.log');
}

export function runLockPath(dataRoot: string): string {
	return join(dataRoot, 'tracked.lock');
}

interface TrackedFile {
	v: number;
	entries: TrackedPath[];
}

export class TrackedStore {
	constructor(readonly dataRoot: string) {}

	list(): TrackedPath[] {
		let text: string;
		try {
			text = readFileSync(trackedPath(this.dataRoot), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw StorageError.from(error);
		}
		let parsed: TrackedFile;
		try {
			parsed = JSON.parse(text) as TrackedFile;
		} catch {
			throw StorageError.badRequest(`${trackedPath(this.dataRoot)} is not valid JSON`);
		}
		if (parsed.v !== VERSION || !Array.isArray(parsed.entries)) {
			throw StorageError.badRequest(`${trackedPath(this.dataRoot)} has an unknown format`);
		}
		return parsed.entries;
	}

	get(id: string): TrackedPath | null {
		return this.list().find((entry) => String(entry.id) === id) ?? null;
	}

	require(id: string): TrackedPath {
		const entry = this.get(id);
		if (!entry) throw StorageError.badRequest(`nothing tracked with id ${id}`);
		return entry;
	}

	add(entry: Omit<TrackedPath, 'id'>): TrackedPath {
		const entries = this.list();
		if (entries.some((existing) => existing.path === entry.path)) {
			throw StorageError.badRequest(`${entry.path} is already tracked`);
		}
		const taken = new Set(entries.map((existing) => String(existing.id)));
		let id: string;
		do id = randomBytes(3).toString('hex');
		while (taken.has(id));
		const added = { id, ...entry };
		this.write([...entries, added]);
		return added;
	}

	update(id: string, changes: Partial<Omit<TrackedPath, 'id'>>): TrackedPath {
		const entries = this.list();
		const index = entries.findIndex((entry) => String(entry.id) === id);
		if (index < 0) throw StorageError.badRequest(`nothing tracked with id ${id}`);
		entries[index] = { ...entries[index], ...changes };
		this.write(entries);
		return entries[index];
	}

	remove(id: string): TrackedPath {
		const entries = this.list();
		const entry = entries.find((existing) => String(existing.id) === id);
		if (!entry) throw StorageError.badRequest(`nothing tracked with id ${id}`);
		this.write(entries.filter((existing) => existing !== entry));
		return entry;
	}

	/** Through a rename, so a cron run reading it never sees half a file. */
	private write(entries: TrackedPath[]): void {
		mkdirSync(this.dataRoot, { recursive: true });
		const target = trackedPath(this.dataRoot);
		const temporary = `${target}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ v: VERSION, entries }, null, 2)}\n`);
		renameSync(temporary, target);
	}
}
