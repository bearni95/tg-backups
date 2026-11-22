import { describeError, log } from '$lib/server/logger';
import { originalName } from '$utils/telegram/backupName';
import { parseByteRange } from '$utils/http/byteRange';
import { attachmentDisposition } from '$utils/http/contentDisposition';
import { StorageError } from './errors';
import type { BackupGroup } from './backup-group';

/** Chunks buffered ahead of the browser: about 4 MiB. */
const READ_AHEAD_CHUNKS = 8;

/** The HTTP response restoring one backup, with single byte-range support. */
export async function restoreResponse(
	group: BackupGroup,
	id: string,
	request: Request
): Promise<Response> {
	const row = group.db.get(id);
	if (!row) throw StorageError.notFound();
	// Nothing is useful in part of a zip.
	if (!group.db.isComplete(row)) throw StorageError.backupIncomplete();

	const total = Math.max(0, row.sizeBytes);
	const headers = new Headers({ 'accept-ranges': 'bytes' });

	const requested = request.headers.get('range');
	let range = { start: 0, end: Math.max(0, total - 1) };
	if (requested !== null) {
		const parsed = parseByteRange(requested, total);
		if (!parsed) {
			headers.set('content-range', `bytes */${total}`);
			return new Response(null, { status: 416, headers });
		}
		range = parsed;
		headers.set('content-range', `bytes ${range.start}-${range.end}/${total}`);
	}

	const bytes = await group.files.downloadRange(id, range.start, range.end);

	headers.set(
		'content-type',
		/^[\t\x20-\x7e]*$/.test(row.mimeType) ? row.mimeType : 'application/octet-stream'
	);
	headers.set('content-length', String(total === 0 ? 0 : range.end - range.start + 1));
	headers.set('content-disposition', attachmentDisposition(originalName(row.name)));

	// HEAD falls through to GET and mustn't pull the backup from Telegram.
	const body = request.method === 'HEAD' ? null : toStream(bytes);
	return new Response(body, { status: requested === null ? 200 : 206, headers });
}

function toStream(bytes: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
	let cancelled = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await bytes.next();
					if (cancelled) return;
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (error) {
					if (cancelled) return;
					log.warn(`restore failed mid-stream: ${describeError(error)}`);
					controller.error(new Error(StorageError.from(error).message));
				}
			},
			async cancel() {
				cancelled = true;
				await bytes.return(undefined);
			}
		},
		{ highWaterMark: READ_AHEAD_CHUNKS }
	);
}
