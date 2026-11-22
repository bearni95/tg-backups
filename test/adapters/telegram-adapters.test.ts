// @vitest-environment node
import { Long, type tl } from '@mtcute/node';
import { describe, expect, it } from 'vitest';
import { telegramAuthAdapter } from '../../src/adapters/classes/telegram-auth.adapter';
import { telegramGroupAdapter } from '../../src/adapters/classes/telegram-group.adapter';
import { telegramFileAdapter } from '../../src/adapters/classes/telegram-file.adapter';
import { telegramMarkerAdapter } from '../../src/adapters/classes/telegram-marker.adapter';
import { telegramMessageAdapter } from '../../src/adapters/classes/telegram-message.adapter';
import { telegramPeerAdapter } from '../../src/adapters/classes/telegram-peer.adapter';

describe('marker adapter', () => {
	const base = {
		groupId: 'g1',
		index: 2,
		total: 5,
		name: 'db.tgb-0123456789ab.zip',
		size: 262144000,
		mime: 'application/zip',
		caption: null,
		checksum: null,
		partChecksum: '0'.repeat(64),
		metadata: undefined
	};

	it('writes the exact caption already in use on Telegram', () => {
		expect(telegramMarkerAdapter.toCaption(base)).toBe(
			`{"caption":null,"checksum":null,"groupId":"g1","index":2,"kind":"tgb-multipart","metadata":null,"mime":"application/zip","name":"db.tgb-0123456789ab.zip","partChecksum":"${'0'.repeat(64)}","size":262144000,"total":5,"v":2}`
		);
	});

	it('round-trips metadata, text and checksums', () => {
		const metadata = { tags: ['movie', '4k'], id: 'x' };
		const caption = telegramMarkerAdapter.toCaption({
			...base,
			caption: 'hello',
			checksum: 'abc',
			metadata
		});
		expect(telegramMarkerAdapter.fromCaption(caption)).toMatchObject({
			index: 2,
			total: 5,
			caption: 'hello',
			checksum: 'abc',
			partChecksum: '0'.repeat(64),
			metadata
		});
	});

	const v1 = {
		v: 1,
		kind: 'tgb-multipart',
		groupId: 'g',
		index: 3,
		total: 5,
		name: 'x.zip',
		size: 5368709120
	};

	it('reads a v1 marker', () => {
		expect(telegramMarkerAdapter.fromCaption(JSON.stringify({ ...v1, caption: null }))).toEqual({
			index: 3,
			total: 5,
			name: 'x.zip',
			size: 5368709120,
			mime: 'application/octet-stream',
			caption: null,
			checksum: null,
			partChecksum: null,
			metadata: undefined
		});
	});

	it.each([
		['the wrong kind', { kind: 'tgb-firkin' }],
		['an unknown version', { v: 99 }],
		['no group id', { groupId: undefined }],
		['a negative index', { index: -1 }],
		['no name', { name: undefined }]
	])('rejects %s', (_label, change) => {
		expect(telegramMarkerAdapter.fromCaption(JSON.stringify({ ...v1, ...change }))).toBeNull();
	});

	it.each(['plain caption', '', '{broken', '[]'])('rejects "%s"', (caption) => {
		expect(telegramMarkerAdapter.fromCaption(caption)).toBeNull();
	});
});

describe('file adapter', () => {
	const row = {
		id: 'id',
		name: 'db.tgb-0123456789ab.zip',
		sizeBytes: 3,
		mimeType: 'application/zip',
		tgMessageId: 1,
		createdAt: '2026-11-22T10:00:00+00:00',
		text: null,
		checksumSha256: null,
		metadata: null
	};

	it('shows the original name and leaves out what is empty', () => {
		expect(JSON.parse(JSON.stringify(telegramFileAdapter.toApi(row, true)))).toEqual({
			id: 'id',
			name: 'db.zip',
			sizeBytes: 3,
			complete: true,
			mimeType: 'application/zip',
			createdAt: row.createdAt
		});
	});

	it('handles null, empty, literal null and invalid metadata', () => {
		const read = (metadata: string | null) => telegramFileAdapter.metadataFromRow({ metadata });
		expect(read(null)).toBeUndefined();
		expect(read('')).toBeUndefined();
		expect(read('not-json')).toBeUndefined();
		expect(read('null')).toBeNull();
		expect(read('{"a":1}')).toEqual({ a: 1 });
	});
});

describe('auth adapter', () => {
	const deliver = (type: tl.auth.TypeSentCodeType) =>
		telegramAuthAdapter.deliveryFromSentCode({
			_: 'auth.sentCode',
			type,
			phoneCodeHash: 'hash',
			nextType: { _: 'auth.codeTypeSms' },
			timeout: 60
		});

	it('reports the app with an SMS fallback', () => {
		expect(deliver({ _: 'auth.sentCodeTypeApp', length: 5 })).toEqual({
			method: 'app',
			length: 5,
			emailPattern: null,
			nextMethod: 'sms',
			timeoutSecs: 60
		});
	});

	it('reports the email pattern', () => {
		const delivery = deliver({
			_: 'auth.sentCodeTypeEmailCode',
			emailPattern: 't***@example.com',
			length: 6
		});
		expect(delivery).toMatchObject({
			method: 'email',
			emailPattern: 't***@example.com',
			length: 6
		});
	});

	it('reports that an email has to be set up', () => {
		expect(deliver({ _: 'auth.sentCodeTypeSetUpEmailRequired' })).toMatchObject({
			method: 'setup_email_required',
			length: null
		});
	});

	it('nulls what a profile lacks', () => {
		expect(
			telegramAuthAdapter.userFromTl({ _: 'user', id: 7, firstName: 'A', lastName: '' })
		).toEqual({
			id: 7,
			firstName: 'A',
			lastName: null,
			username: null,
			phone: null
		});
	});
});

describe('peer adapter', () => {
	it('keeps the access hash exactly', () => {
		const accessHash = Long.fromString('-8123456789012345678');
		const ref = { kind: 'channel' as const, id: 7, accessHash };
		expect(telegramPeerAdapter.toInputPeer(ref)).toEqual({
			_: 'inputPeerChannel',
			channelId: 7,
			accessHash
		});
		expect(telegramPeerAdapter.matches({ _: 'peerChannel', channelId: 7 }, ref)).toBe(true);
		expect(telegramPeerAdapter.matches({ _: 'peerChat', chatId: 7 }, ref)).toBe(false);
	});
});

describe('group adapter', () => {
	const channel = (flags: Partial<tl.RawChannel>): tl.RawChannel => ({
		_: 'channel',
		megagroup: true,
		id: 7,
		accessHash: Long.fromString('-8123456789012345678'),
		title: 'Backups',
		photo: { _: 'chatPhotoEmpty' },
		date: 1,
		...flags
	});
	const noFiles: tl.RawChatBannedRights = { _: 'chatBannedRights', sendDocs: true, untilDate: 0 };

	it('round-trips the access hash exactly', () => {
		const saved = telegramGroupAdapter.fromChat(channel({}))!;
		expect(saved).toEqual({
			id: 'channel-7',
			title: 'Backups',
			accessHash: '-8123456789012345678'
		});
		expect(telegramGroupAdapter.toPeer(saved, Long.fromString).accessHash.toString()).toBe(
			saved.accessHash
		);
	});

	it.each<[string, Partial<tl.RawChannel>]>([
		['left', { left: true }],
		['min', { min: true }],
		['no hash', { accessHash: undefined }],
		['a channel it only reads', { megagroup: false, broadcast: true }],
		['files banned for all', { defaultBannedRights: noFiles }],
		['files banned for it', { bannedRights: noFiles }]
	])('refuses %s', (_label, flags) => {
		expect(telegramGroupAdapter.fromChat(channel(flags))).toBeNull();
	});

	it('lets a creator past the default restrictions', () => {
		const chat = channel({ creator: true, defaultBannedRights: noFiles });
		expect(telegramGroupAdapter.fromChat(chat)).not.toBeNull();
	});

	it.each(['channel-', 'user-5', 'channel-1/../../x', '../channel-1', 'channel-0'])(
		'%s is not a group id',
		(id) => {
			expect(telegramGroupAdapter.isGroupId(id)).toBe(false);
		}
	);
});

describe('message adapter', () => {
	it('finds the sent id by random id', () => {
		const randomId = Long.fromNumber(99);
		const updates: tl.TypeUpdates = {
			_: 'updates',
			updates: [
				{ _: 'updateMessageID', id: 1, randomId: Long.fromNumber(5) },
				{ _: 'updateMessageID', id: 2, randomId }
			],
			users: [],
			chats: [],
			date: 0,
			seq: 0
		};
		expect(telegramMessageAdapter.sentIdFrom(updates, randomId)).toBe(2);
		expect(telegramMessageAdapter.sentIdFrom(updates, Long.ONE)).toBeNull();
	});
});
