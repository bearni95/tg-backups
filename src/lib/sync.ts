/** A FIFO semaphore. */
export class Semaphore {
	private waiting: (() => void)[] = [];
	private available: number;

	constructor(permits = 1) {
		this.available = permits;
	}

	/** Resolves to the function that gives the permit back. */
	async acquire(): Promise<() => void> {
		if (this.available > 0) this.available -= 1;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));

		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiting.shift();
			// Hand the permit straight over, so a newcomer can't jump the queue.
			if (next) next();
			else this.available += 1;
		};
	}

	async run<T>(task: () => T | Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await task();
		} finally {
			release();
		}
	}
}

/** Runs a task until it succeeds once, then keeps the result. Concurrent callers share a run. */
export class OnceAsync<T> {
	private done: { value: T } | null = null;
	private running: Promise<T> | null = null;

	/** `ran` is true only for the caller whose task produced the value. */
	async run(task: () => Promise<T>): Promise<{ value: T; ran: boolean }> {
		for (;;) {
			if (this.done) return { value: this.done.value, ran: false };
			if (!this.running) break;
			// A failed run leaves the cell empty, so each waiter gets its own attempt.
			await this.running.catch(() => undefined);
		}
		this.running = task();
		try {
			const value = await this.running;
			this.done = { value };
			return { value, ran: true };
		} finally {
			this.running = null;
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
