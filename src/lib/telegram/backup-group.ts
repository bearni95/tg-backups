import { OnceAsync } from '$lib/sync';
import type { GroupDetails, PeerRef } from '$types/telegram-server.type';
import type { Connection } from './connection';
import type { IndexDb } from './db';
import { BackupFiles } from './files';
import { inspectGroup } from './group-admin';

const MEMBERSHIP_TTL_MS = 60 * 60 * 1000;

/**
 * One group as a backup destination, for one account on one connection.
 *
 * Every operation takes one and keeps it to the end, so switching groups can't
 * redirect a transfer under way. Each has its own index: message ids repeat
 * from group to group, so a shared one would restore the wrong bytes.
 */
export class BackupGroup {
	/** The walk runs once per group and connection; a failed walk runs again. */
	readonly indexReconciled = new OnceAsync<number>();
	readonly metadataReconciled = new OnceAsync<number>();
	readonly files: BackupFiles;

	private verifiedAt: number | null = null;

	constructor(
		readonly id: string,
		public title: string,
		readonly peer: PeerRef,
		readonly userId: number,
		readonly connection: Connection,
		readonly db: IndexDb
	) {
		this.files = new BackupFiles(this);
	}

	async inspect(): Promise<GroupDetails> {
		this.verifiedAt = null;
		const details = await inspectGroup(this.connection, this.peer, this.userId);
		this.title = details.title;
		this.verifiedAt = performance.now();
		return details;
	}

	/** Someone removed from the group loses access here within the hour. */
	async ensureMember(): Promise<void> {
		if (this.verifiedAt !== null && performance.now() - this.verifiedAt < MEMBERSHIP_TTL_MS) return;
		await this.inspect();
	}
}
