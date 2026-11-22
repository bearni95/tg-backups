import { describe, expect, it } from 'vitest';
import { originalName, storedName } from '../../../src/utils/telegram/backupName';
import { isAllowedBackup, ZIP_MIME_TYPES } from '../../../src/utils/telegram/mediaType';

describe('backupName', () => {
	const digest = '0123456789abcdef';

	it.each(['db.zip', 'my.photos.2026.ZIP', 'còpia de seguretat.zip', 'x.tgb-y.zip'])(
		'round-trips %s',
		(name) => {
			expect(originalName(storedName(name, digest))).toBe(name);
		}
	);

	it('puts twelve hex digits before the extension', () => {
		expect(storedName('db.zip', digest)).toBe('db.tgb-0123456789ab.zip');
		expect(storedName('db', digest)).toBe('db.tgb-0123456789ab.zip');
	});

	it.each(['plain.zip', 'x.tgb-nothex.zip', 'x.tgb-0123456789abc.zip', 'noextension'])(
		'passes %s through',
		(name) => {
			expect(originalName(name)).toBe(name);
		}
	);
});

describe('mediaType', () => {
	it.each(ZIP_MIME_TYPES)('accepts a zip sent as "%s"', (mime) => {
		expect(isAllowedBackup('backup.zip', mime)).toBe(true);
	});

	it('ignores case', () => {
		expect(isAllowedBackup('Photos.2026.ZIP', 'APPLICATION/ZIP')).toBe(true);
	});

	it.each([
		['clip.mp4', 'video/mp4'],
		['backup.tar.gz', 'application/gzip'],
		['backup.zip.part1of3', 'application/octet-stream'],
		['backup', 'application/zip'],
		['.zip', 'application/zip'],
		['fake.zip', 'text/html']
	])('rejects %s as %s', (name, mime) => {
		expect(isAllowedBackup(name, mime)).toBe(false);
	});
});
