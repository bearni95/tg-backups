// @vitest-environment node
// The real mtcute client, with only the network replaced.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Long, type BaseTelegramClient, type tl } from '@mtcute/node';
import { __tlReaderMap, __tlWriterMap } from '@mtcute/node/utils.js';
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telegramMessageAdapter } from '../../src/adapters/classes/telegram-message.adapter';
import { autoRetryDelayMs, Connection } from '../../src/lib/server/telegram/connection';
import { submitPassword } from '../../src/lib/server/telegram/auth';
import { StorageError } from '../../src/lib/server/telegram/errors';
import { FileSession } from '../../src/lib/server/telegram/session';
import { MtcuteTransport } from '../../src/lib/server/telegram/transport';

let root: string;
let session: FileSession;
let transport: MtcuteTransport;
let client: BaseTelegramClient;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'tgb-transport-'));
	session = FileSession.open(join(root, 'session.sqlite'));
	transport = new MtcuteTransport(session, 12345, 'hash');
	client = (transport as unknown as { client: BaseTelegramClient }).client;
	vi.spyOn(client.mt, 'connect').mockResolvedValue();
});

afterEach(async () => {
	await transport.close();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** What the session layer resolves with: Telegram's untouched rpc_error. */
function answer(...responses: unknown[]) {
	const call = vi.spyOn(client.mt, 'call');
	for (const response of responses) call.mockResolvedValueOnce(response as never);
	return call;
}

const rpcError = (errorCode: number, errorMessage: string) => ({
	_: 'mt_rpc_error',
	errorCode,
	errorMessage
});

describe('errors from the real client', () => {
	it.each([
		[420, 'FLOOD_WAIT_7', 'FLOOD_WAIT', 7],
		[420, 'FLOOD_PREMIUM_WAIT_3', 'FLOOD_PREMIUM_WAIT', 3],
		[303, 'FILE_MIGRATE_5', 'FILE_MIGRATE', 5],
		[303, 'PHONE_MIGRATE_4', 'PHONE_MIGRATE', 4],
		[401, 'SESSION_REVOKED', 'SESSION_REVOKED', null]
	])('%i %s keeps its number', async (code, text, rpcName, value) => {
		answer(rpcError(code, text));
		await expect(transport.invoke({ _: 'updates.getState' })).rejects.toMatchObject({
			kind: 'rpc',
			code,
			rpcName,
			value
		});
	});

	it('so a flood wait is retried and reported with its delay', async () => {
		answer(rpcError(420, 'FLOOD_WAIT_7'));
		const error = await transport.invoke({ _: 'updates.getState' }).catch((reason) => reason);
		expect(autoRetryDelayMs(error)).toBe(7000);
		expect(StorageError.from(error).details.retryAfterSeconds).toBe(7);
	});

	it('passes results through, falsy ones included', async () => {
		answer(false, []);
		const part = { fileId: Long.ONE, filePart: 0, bytes: new Uint8Array(1) };
		expect(await transport.invoke({ _: 'upload.saveFilePart', ...part })).toBe(false);
		expect(await transport.invoke({ _: 'users.getUsers', id: [] })).toEqual([]);
	});

	it('times out instead of hanging offline', async () => {
		vi.spyOn(client.mt, 'call').mockReturnValue(new Promise(() => {}) as never);
		await expect(
			transport.invoke({ _: 'updates.getState' }, { timeoutMs: 30 })
		).rejects.toMatchObject({ kind: 'io' });
	});

	it('releases a pending call on shutdown', async () => {
		vi.spyOn(client.mt, 'call').mockReturnValue(new Promise(() => {}) as never);
		const pending = transport.invoke({ _: 'updates.getState' });
		const rejected = expect(pending).rejects.toMatchObject({ kind: 'dropped' });
		await transport.close();
		await rejected;
	});
});

describe('password login on the real client', () => {
	it('computes SRP and records who signed in', async () => {
		const password: tl.account.RawPassword = {
			_: 'account.password',
			currentAlgo: {
				_: 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
				salt1: new Uint8Array(8).fill(1),
				salt2: new Uint8Array(16).fill(2),
				g: 3,
				p: new Uint8Array(256).fill(0xfb)
			},
			srpB: new Uint8Array(256).fill(5),
			srpId: Long.ONE,
			newAlgo: { _: 'passwordKdfAlgoUnknown' },
			newSecureAlgo: { _: 'securePasswordKdfAlgoUnknown' },
			secureRandom: new Uint8Array(0)
		};
		const user: tl.RawUser = {
			_: 'user',
			id: 4242,
			accessHash: Long.fromNumber(9),
			firstName: 'T'
		};
		const call = answer(
			password,
			{ _: 'auth.authorization', user },
			{ _: 'updates.state', pts: 10, qts: 2, date: 30, seq: 4, unreadCount: 0 }
		);

		await client.prepare();
		const connection = new Connection(transport, session, 12345, 'hash');
		expect(await submitPassword(connection, 'secret')).toEqual(user);

		const sent = call.mock.calls[1][0] as unknown as tl.auth.RawCheckPasswordRequest;
		expect(sent.password).toMatchObject({ _: 'inputCheckPasswordSRP', srpId: Long.ONE });
		expect(readFileSync(join(root, 'session.sqlite'), 'utf8')).toContain('"is_self":true');
	});
});

describe('responses as the real TL reader builds them', () => {
	it('yields a document the adapters understand', () => {
		const accessHash = Long.fromString('-8123456789012345678');
		const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, {
			_: 'message',
			id: 46,
			peerId: { _: 'peerChannel', channelId: 1234567890 },
			date: 1,
			message: 'caption',
			media: {
				_: 'messageMediaDocument',
				document: {
					_: 'document',
					id: Long.fromNumber(7),
					accessHash,
					fileReference: new Uint8Array([1, 2]),
					date: 1,
					mimeType: 'application/zip',
					size: 52428800,
					dcId: 4,
					attributes: [{ _: 'documentAttributeFilename', fileName: 'db.zip' }]
				}
			}
		} as { _: string });

		const message = TlBinaryReader.deserializeObject<tl.TypeMessage>(__tlReaderMap, bytes);
		const document = telegramMessageAdapter.documentFrom(message)!;
		expect(document).toMatchObject({ name: 'db.zip', size: 52428800, dcId: 4 });
		expect(document.location.accessHash.eq(accessHash)).toBe(true);
	});
});
