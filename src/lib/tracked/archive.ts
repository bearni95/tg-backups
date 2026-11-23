// Zips of tracked files and folders. The same content always makes the same
// bytes, so an unchanged path is recognised and not uploaded again.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { collectFiles } from '$lib/telegram/local-paths';

/** What a tracked path is stored as: `notes.txt` → `notes.txt.zip`. */
export function archiveName(path: string): string {
	return `${basename(path)}.zip`;
}

/**
 * Write a zip of a file, or of a folder under its own name. Folder entries go
 * in sorted order with their own times and modes, and nothing else varies.
 */
export async function writeArchive(
	source: string,
	target: string,
	dataRoot: string
): Promise<void> {
	const zip = new ZipFile();
	const root = basename(source);
	const info = await stat(source);

	if (info.isDirectory()) {
		for (const { path } of await collectFiles(source, dataRoot)) {
			const file = path.toString();
			const entry = await stat(file);
			const inside = relative(source, file).split(sep).join('/');
			zip.addFile(file, `${root}/${inside}`, { mtime: entry.mtime, mode: entry.mode });
		}
	} else {
		zip.addFile(source, root, { mtime: info.mtime, mode: info.mode });
	}

	await mkdir(dirname(target), { recursive: true });
	zip.end();
	await pipeline(zip.outputStream, createWriteStream(target));
}
