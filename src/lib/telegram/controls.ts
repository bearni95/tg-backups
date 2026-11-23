import { sleep } from '$lib/sync';
import { StorageError } from './errors';

const PAUSE_POLL_MS = 100;

/** Pause takes effect at the next 512 KiB part boundary. */
export class PauseControl {
	private paused = false;

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	get isPaused(): boolean {
		return this.paused;
	}
}

/** Cooperative cancel: the next part boundary throws. Landed chunks stay, for a resume. */
export class AbortControl {
	private aborted = false;

	abort(): void {
		this.aborted = true;
	}

	get isAborted(): boolean {
		return this.aborted;
	}
}

export function checkAbort(abort?: AbortControl): void {
	if (abort?.isAborted) throw StorageError.uploadAborted();
}

export async function waitWhilePaused(pause?: PauseControl): Promise<void> {
	while (pause?.isPaused) await sleep(PAUSE_POLL_MS);
}
