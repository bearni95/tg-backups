import { describe, expect, it } from 'vitest';
import {
	accessGroupInviteUrl,
	parseGroupIdCandidates,
	parseGroupUsername,
	parseInviteHash
} from '../../../src/utils/telegram/accessGroup';
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

describe('accessGroup', () => {
	const hash = 'hAJfgmURLbxhYzM0';

	it.each([
		`https://t.me/+${hash}`,
		`http://t.me/+${hash}`,
		`t.me/+${hash}`,
		`telegram.me/+${hash}`,
		`+${hash}`,
		`https://t.me/joinchat/${hash}`,
		`  https://t.me/+${hash}  `
	])('finds the invite hash in %s', (spec) => {
		expect(parseInviteHash(spec)).toBe(hash);
	});

	it.each(['@my_group', 'my_group', '-1001234567890', '+'])('%s is not an invite', (spec) => {
		expect(parseInviteHash(spec)).toBeNull();
	});

	it('reads usernames', () => {
		expect(parseGroupUsername('@my_group')).toBe('my_group');
		expect(parseGroupUsername('my_group')).toBe('my_group');
		expect(parseGroupUsername('  @spaced  ')).toBe('spaced');
		expect(parseGroupUsername('-1001234567890')).toBeNull();
		expect(parseGroupUsername('1234567890')).toBeNull();
		expect(parseGroupUsername('@')).toBeNull();
	});

	it('reads numeric ids', () => {
		expect(parseGroupIdCandidates('-1001234567890')).toEqual([1001234567890, 1234567890]);
		expect(parseGroupIdCandidates('1234567890')).toEqual([1234567890]);
		expect(parseGroupIdCandidates('-987654')).toEqual([987654]);
		expect(parseGroupIdCandidates('my_group')).toBeNull();
		expect(parseGroupIdCandidates('@my_group')).toBeNull();
		expect(parseGroupIdCandidates('')).toBeNull();
	});

	it('derives the link to share', () => {
		expect(accessGroupInviteUrl(`t.me/joinchat/${hash}`)).toBe(`https://t.me/+${hash}`);
		expect(accessGroupInviteUrl('@my_group')).toBe('https://t.me/my_group');
		expect(accessGroupInviteUrl('-1001234567890')).toBeNull();
		expect(accessGroupInviteUrl(null)).toBeNull();
	});
});
