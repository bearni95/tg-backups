import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError, log } from '$lib/server/logger';
import { MultipartReader, type MultipartPart } from '$lib/server/http/multipart';
import { parseJson } from '$utils/json/losslessJson';
import { isAllowedBackup } from '$utils/telegram/mediaType';
import { StorageError } from './errors';
import { guessMime } from './local-paths';
import { telegramDir } from './paths';
import type { TelegramStorage } from './storage';
import { MAX_UPLOAD_BYTES } from './upload';

/** Stage a multipart upload on disk, then send it to the group. Returns the file id. */
export async function uploadFromBrowser(
	storage: TelegramStorage,
	request: Request
): Promise<string> {
	const form = new MultipartReader(request.body, request.headers.get('content-type'));

	let staged: string | null = null;
	try {
		let name: string | null = null;
		let contentType: string | null = null;
		let metadata: unknown;
		let text: string | undefined;

		for await (const part of form.parts()) {
			if (part.name === 'name') {
				name = await part.text();
			} else if (part.name === 'metadata') {
				const raw = (await part.text()).trim();
				if (raw) metadata = parseMetadata(raw);
			} else if (part.name === 'text') {
				text = (await part.text()) || text;
			} else if (part.name === 'file') {
				name ??= part.filename;
				contentType = part.contentType ?? contentType;
				// Reject before staging gigabytes.
				const probeName = name ?? '';
				const probeMime = contentType ?? guessMime(probeName);
				if (!isAllowedBackup(probeName, probeMime)) {
					throw StorageError.unsupportedMediaType(probeName, probeMime);
				}

				if (staged) await rm(staged, { force: true });
				await mkdir(telegramDir(storage.dataRoot), { recursive: true });
				staged = join(telegramDir(storage.dataRoot), `upload-${randomUUID()}.tmp`);
				await writePart(part, staged);
			}
			// `size` and anything else is ignored: the size comes from the disk.
		}

		if (!staged) throw StorageError.badRequest("multipart 'file' field missing");
		if (name === null) throw StorageError.badRequest('file name missing');

		const result = await storage.files.uploadLocalFile(staged, {
			name,
			mimeType: contentType ?? guessMime(name),
			totalSize: 0,
			metadata,
			text
		});
		return result.id;
	} catch (error) {
		// Not awaited: answer now, while the browser may still be sending.
		form.drain().catch((reason) => log.info(`upload body discarded: ${describeError(reason)}`));
		throw error;
	} finally {
		if (staged) {
			await rm(staged, { force: true }).catch((error) =>
				log.warn(`could not remove ${staged}: ${describeError(error)}`)
			);
		}
	}
}

function parseMetadata(raw: string): unknown {
	try {
		return parseJson(raw);
	} catch (error) {
		throw StorageError.badRequest(`metadata is not valid JSON: ${describeError(error)}`);
	}
}

async function writePart(part: MultipartPart, path: string): Promise<void> {
	const handle = await open(path, 'w');
	try {
		let written = 0;
		for await (const chunk of part.chunks()) {
			written += chunk.length;
			if (written > MAX_UPLOAD_BYTES) throw StorageError.fileTooLarge(MAX_UPLOAD_BYTES);
			await handle.writeFile(chunk);
		}
	} finally {
		await handle.close();
	}
}
