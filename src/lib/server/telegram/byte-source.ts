import type { FileHandle } from 'node:fs/promises';

/** A seekable reader. `read` only comes up short at the end of the data. */
export interface ByteSource {
	position: number;
	read(length: number): Promise<Buffer>;
}

export class FileSource implements ByteSource {
	position = 0;

	constructor(private readonly handle: FileHandle) {}

	async read(length: number): Promise<Buffer> {
		const buffer = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await this.handle.read(
				buffer,
				filled,
				length - filled,
				this.position + filled
			);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		this.position += filled;
		return buffer.subarray(0, filled);
	}
}

export class BufferSource implements ByteSource {
	position = 0;

	constructor(private readonly data: Uint8Array) {}

	async read(length: number): Promise<Buffer> {
		const piece = Buffer.from(this.data.subarray(this.position, this.position + length));
		this.position += piece.length;
		return piece;
	}
}
