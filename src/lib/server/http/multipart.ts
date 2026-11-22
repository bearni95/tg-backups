// A streaming multipart/form-data reader. `request.formData()` holds the whole
// body in memory, and these bodies are zips of up to 200 GiB.
import { StorageError } from '$lib/server/telegram/errors';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const CRLF = Buffer.from('\r\n');
const HEADERS_END = Buffer.from('\r\n\r\n');

export interface MultipartPart {
	name: string;
	filename: string | null;
	/** Null when the part didn't send one, unlike text/plain. */
	contentType: string | null;
	chunks(): AsyncGenerator<Buffer>;
	text(): Promise<string>;
}

function invalid(reason: string): StorageError {
	return StorageError.badRequest(`multipart: ${reason}`);
}

function dispositionParam(header: string, wanted: string): string | null {
	const pattern = /;\s*([^=;\s]+)\s*=\s*(?:"((?:\\"|[^"])*)"|([^;]*))/g;
	for (const [, key, quoted, bare] of header.matchAll(pattern)) {
		if (key.toLowerCase() === wanted) return quoted?.replaceAll('\\"', '"') ?? bare.trim();
	}
	return null;
}

export class MultipartReader {
	// The first boundary has no line break before it, so pretend it does.
	private buffer: Buffer = Buffer.from('\r\n');
	private ended = false;
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly delimiter: Buffer;

	constructor(body: ReadableStream<Uint8Array> | null, contentType: string | null) {
		const boundary = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(
			contentType ?? ''
		);
		if (!boundary) throw invalid('expected multipart/form-data with a boundary');
		if (!body) throw invalid('request has no body');
		this.delimiter = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`);
		this.reader = body.getReader();
	}

	async *parts(): AsyncGenerator<MultipartPart> {
		await this.skipToDelimiter();
		for (;;) {
			while (this.buffer.length < 2) await this.fill();
			if (this.buffer[0] === 0x2d && this.buffer[1] === 0x2d) {
				await this.drain();
				return;
			}
			await this.take(CRLF);
			const headers = await this.readHeaders();

			const disposition = headers.get('content-disposition') ?? '';
			const state = { done: false };
			const part: MultipartPart = {
				name: dispositionParam(disposition, 'name') ?? '',
				filename: dispositionParam(disposition, 'filename'),
				contentType: headers.get('content-type') ?? null,
				chunks: () => this.untilDelimiter(state),
				text: async () => {
					const pieces: Buffer[] = [];
					let size = 0;
					for await (const piece of this.untilDelimiter(state)) {
						size += piece.length;
						if (size > MAX_TEXT_BYTES) throw invalid('text field is too large');
						// Copy: the piece is a view into the read buffer.
						pieces.push(Buffer.from(piece));
					}
					return Buffer.concat(pieces).toString('utf8');
				}
			};
			yield part;
			if (!state.done) await this.skipToDelimiter(state);
		}
	}

	/**
	 * Read and drop the rest of the body. Cancelling would destroy the socket,
	 * and the error response with it.
	 */
	async drain(): Promise<void> {
		this.buffer = Buffer.alloc(0);
		while (!this.ended) this.ended = (await this.reader.read()).done;
	}

	private async fill(): Promise<void> {
		const { done, value } = await this.reader.read();
		if (done) {
			this.ended = true;
			throw invalid('unexpected end of body');
		}
		const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
	}

	/** The bytes before `marker`, consuming both. */
	private async take(marker: Buffer): Promise<Buffer> {
		for (;;) {
			const index = this.buffer.indexOf(marker);
			if (index >= 0) {
				const head = this.buffer.subarray(0, index);
				this.buffer = this.buffer.subarray(index + marker.length);
				return head;
			}
			if (this.buffer.length > MAX_HEADER_BYTES) throw invalid('part headers are too large');
			await this.fill();
		}
	}

	private async readHeaders(): Promise<Map<string, string>> {
		while (this.buffer.length < CRLF.length) await this.fill();
		const headers = new Map<string, string>();
		if (this.buffer.subarray(0, CRLF.length).equals(CRLF)) {
			this.buffer = this.buffer.subarray(CRLF.length);
			return headers;
		}
		for (const line of (await this.take(HEADERS_END)).toString('utf8').split('\r\n')) {
			const colon = line.indexOf(':');
			if (colon > 0)
				headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
		}
		return headers;
	}

	private async *untilDelimiter(state = { done: false }): AsyncGenerator<Buffer> {
		while (!state.done) {
			const index = this.buffer.indexOf(this.delimiter);
			if (index >= 0) {
				const last = this.buffer.subarray(0, index);
				this.buffer = this.buffer.subarray(index + this.delimiter.length);
				state.done = true;
				if (last.length > 0) yield last;
				return;
			}
			// Hold back enough to catch a delimiter split across reads.
			const safe = this.buffer.length - this.delimiter.length + 1;
			if (safe > 0) {
				const piece = this.buffer.subarray(0, safe);
				this.buffer = this.buffer.subarray(safe);
				yield piece;
			}
			await this.fill();
		}
	}

	private async skipToDelimiter(state = { done: false }): Promise<void> {
		const rest = this.untilDelimiter(state);
		while (!(await rest.next()).done);
	}
}
