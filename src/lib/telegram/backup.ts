import { createHash } from 'node:crypto';
import type { ByteSource } from './byte-source';
import { checkAbort, type AbortControl } from './controls';

export const READ_BUFFER_BYTES = 1024 * 1024;

/** SHA-256 of the next `size` bytes. Leaves the cursor where it found it. */
export async function contentSha256(
	source: ByteSource,
	size: number,
	abort?: AbortControl
): Promise<string> {
	const start = source.position;
	const hash = createHash('sha256');
	let remaining = size;
	for (;;) {
		checkAbort(abort);
		if (remaining <= 0) break;
		const piece = await source.read(Math.min(remaining, READ_BUFFER_BYTES));
		if (piece.length === 0) break;
		hash.update(piece);
		remaining -= piece.length;
	}
	source.position = start;
	return hash.digest('hex');
}
