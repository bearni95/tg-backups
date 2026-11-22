import { createHash } from 'node:crypto';
import { Long, type tl } from '@mtcute/node';
import { __tlWriterMap } from '@mtcute/node/utils.js';
import { TlBinaryWriter } from '@mtcute/tl-runtime';
import { InvocationError } from '../../../src/lib/server/telegram/invocation-error';
import type {
	InvokeOptions,
	Transport,
	TransportFactory
} from '../../../src/lib/server/telegram/transport';

export const CHANNEL_ID = 1234567890;
export const USER_ID = 4242;

const CHANNEL_HASH = Long.fromString('8123456789012345678');
const USER_HASH = Long.fromString('-7123456789012345678');

interface SavedUpload {
	method: 'small' | 'big';
	parts: Map<number, Buffer>;
}

interface Call {
	request: tl.RpcMethod;
	options: InvokeOptions;
}

/**
 * A Telegram account and one group, at the raw TL boundary. Every request is
 * serialised with the real schema, so a malformed one fails the test.
 */
export class FakeTelegram {
	authorized = true;
	member = true;
	premigrateDc: number | null = null;
	qr: 'pending' | 'success' | 'password' | 'migrate' = 'pending';
	/** The kind of group the invite, username or dialog resolves to. */
	basicGroup = false;
	passwordNeeded = false;
	dialogsBefore = 0;

	messages: tl.TypeMessage[] = [];
	calls: Call[] = [];
	transports: FakeTransport[] = [];
	/** Throw (or return an error) to make a call fail. */
	intercept: ((request: tl.RpcMethod, options: InvokeOptions) => void | Promise<void>) | null =
		null;

	private nextId = 1;
	private uploads = new Map<string, SavedUpload>();
	private documents = new Map<string, Buffer>();

	readonly user: tl.RawUser = {
		_: 'user',
		self: true,
		id: USER_ID,
		accessHash: USER_HASH,
		firstName: 'Test',
		lastName: '',
		username: 'tester',
		phone: '12025550100'
	};

	readonly factory: TransportFactory = (session) => {
		const transport = new FakeTransport(this, (id) => session.setHomeDc(id));
		this.transports.push(transport);
		return transport;
	};

	get peer(): tl.TypePeer {
		return this.basicGroup
			? { _: 'peerChat', chatId: CHANNEL_ID }
			: { _: 'peerChannel', channelId: CHANNEL_ID };
	}

	get chat(): tl.TypeChat {
		if (this.basicGroup) {
			return {
				_: 'chat',
				id: CHANNEL_ID,
				title: 'tgb',
				photo: { _: 'chatPhotoEmpty' },
				participantsCount: 1,
				date: 1,
				version: 1
			};
		}
		return {
			_: 'channel',
			megagroup: true,
			id: CHANNEL_ID,
			accessHash: CHANNEL_HASH,
			title: 'tgb',
			photo: { _: 'chatPhotoEmpty' },
			date: 1
		};
	}

	count(method: tl.RpcMethod['_']): number {
		return this.calls.filter((call) => call.request._ === method).length;
	}

	requests<M extends tl.RpcMethod['_']>(method: M): Extract<tl.RpcMethod, { _: M }>[] {
		return this.calls
			.filter((call) => call.request._ === method)
			.map((call) => call.request as Extract<tl.RpcMethod, { _: M }>);
	}

	captions(): string[] {
		return this.messages.flatMap((message) => (message._ === 'message' ? [message.message] : []));
	}

	addText(text = ''): number {
		const id = this.nextId++;
		this.messages.push({ _: 'message', id, peerId: this.peer, date: id, message: text });
		return id;
	}

	addDocument(
		name: string,
		bytes: Uint8Array,
		{
			caption = '',
			mimeType = 'application/zip',
			dcId = 2
		}: { caption?: string; mimeType?: string; dcId?: number } = {}
	): number {
		const id = this.nextId++;
		this.documents.set(String(id), Buffer.from(bytes));
		this.messages.push({
			_: 'message',
			id,
			peerId: this.peer,
			date: id,
			message: caption,
			media: {
				_: 'messageMediaDocument',
				document: {
					_: 'document',
					id: Long.fromNumber(id),
					accessHash: Long.ONE,
					fileReference: new Uint8Array([id & 0xff]),
					date: id,
					mimeType,
					size: bytes.length,
					dcId,
					attributes: [{ _: 'documentAttributeFilename', fileName: name }]
				}
			}
		});
		return id;
	}

	remove(...ids: number[]): void {
		this.messages = this.messages.filter((message) => !ids.includes(message.id));
	}

	async handle(request: tl.RpcMethod, options: InvokeOptions): Promise<unknown> {
		// Part payloads are up to 512 KiB: the schema check doesn't need every byte.
		const checked = 'bytes' in request ? { ...request, bytes: new Uint8Array(4) } : request;
		TlBinaryWriter.serializeObject(__tlWriterMap, checked as { _: string });
		this.calls.push({ request, options });
		await this.intercept?.(request, options);

		switch (request._) {
			case 'help.getConfig':
				return {};
			case 'updates.getState':
				if (!this.authorized) throw InvocationError.rpc(401, 'AUTH_KEY_UNREGISTERED');
				return { _: 'updates.state', pts: 10, qts: 2, date: 30, seq: 4, unreadCount: 0 };
			case 'users.getUsers':
				return [this.user];
			case 'auth.sendCode':
				if (this.premigrateDc !== null) {
					const dc = this.premigrateDc;
					this.premigrateDc = null;
					throw InvocationError.rpc(303, `PHONE_MIGRATE_${dc}`);
				}
				return this.sentCode('hash-1');
			case 'auth.resendCode':
				return this.sentCode('hash-2');
			case 'auth.signIn':
				if (request.phoneCode !== '12345') throw InvocationError.rpc(400, 'PHONE_CODE_INVALID');
				if (this.passwordNeeded) throw InvocationError.rpc(401, 'SESSION_PASSWORD_NEEDED');
				return this.signIn();
			case 'account.getPassword':
				return { _: 'account.password', hint: 'pet' };
			case 'auth.checkPassword':
				if (
					Buffer.from(
						request.password._ === 'inputCheckPasswordSRP' ? request.password.A : []
					).toString() !== 'secret'
				) {
					throw InvocationError.rpc(400, 'PASSWORD_HASH_INVALID');
				}
				return this.signIn();
			case 'auth.exportLoginToken':
				if (this.qr === 'password') throw InvocationError.rpc(401, 'SESSION_PASSWORD_NEEDED');
				if (this.qr === 'migrate') {
					return { _: 'auth.loginTokenMigrateTo', dcId: 4, token: new Uint8Array([9]) };
				}
				if (this.qr === 'success') {
					return { _: 'auth.loginTokenSuccess', authorization: this.signIn() };
				}
				return { _: 'auth.loginToken', expires: 99, token: new Uint8Array([0xfb, 0xff]) };
			case 'auth.importLoginToken':
				return { _: 'auth.loginTokenSuccess', authorization: this.signIn() };
			case 'auth.logOut':
				this.authorized = false;
				return { _: 'auth.loggedOut' };
			case 'messages.checkChatInvite':
				if (request.hash === 'bad') throw InvocationError.rpc(400, 'INVITE_HASH_INVALID');
				return this.member
					? { _: 'chatInviteAlready', chat: this.chat }
					: { _: 'chatInvite', title: 'tgb', participantsCount: 1 };
			case 'contacts.resolveUsername':
				if (request.username === 'missing') throw InvocationError.rpc(400, 'USERNAME_NOT_OCCUPIED');
				return { peer: this.peer, users: [], chats: [this.chat] };
			case 'channels.getParticipant':
				if (!this.member) throw InvocationError.rpc(400, 'USER_NOT_PARTICIPANT');
				return {};
			case 'messages.getFullChat':
				return {
					fullChat: {
						_: 'chatFull',
						participants: {
							_: 'chatParticipants',
							participants: this.member ? [{ userId: USER_ID }] : []
						}
					}
				};
			case 'messages.getDialogs':
				return this.dialogs(request);
			case 'messages.getHistory': {
				const messages = [...this.messages]
					.sort((a, b) => b.id - a.id)
					.filter((message) => !request.offsetId || message.id < request.offsetId)
					.slice(0, request.limit);
				const count = this.messages.length;
				return { _: 'messages.channelMessages', count, messages, users: [], chats: [] };
			}
			case 'channels.getMessages':
			case 'messages.getMessages': {
				if (request.id.length > 100) throw InvocationError.rpc(400, 'LIMIT_INVALID');
				const messages = request.id.map((input) => {
					const id = input._ === 'inputMessageID' ? input.id : 0;
					return this.messages.find((message) => message.id === id) ?? { _: 'messageEmpty', id };
				});
				return { _: 'messages.messages', messages, users: [], chats: [] };
			}
			case 'channels.deleteMessages':
			case 'messages.deleteMessages':
				if (request.id.length > 100) throw InvocationError.rpc(400, 'LIMIT_INVALID');
				this.remove(...request.id);
				return { _: 'messages.affectedMessages', pts: 1, ptsCount: request.id.length };
			case 'upload.saveFilePart':
			case 'upload.saveBigFilePart': {
				const key = request.fileId.toString();
				let upload = this.uploads.get(key);
				if (!upload) {
					upload = {
						method: request._ === 'upload.saveFilePart' ? 'small' : 'big',
						parts: new Map()
					};
					this.uploads.set(key, upload);
				}
				upload.parts.set(request.filePart, Buffer.from(request.bytes));
				return true;
			}
			case 'messages.sendMedia':
				return this.send(request);
			case 'upload.getFile': {
				const { location, offset, limit } = request;
				if (location._ !== 'inputDocumentFileLocation' || offset % 4096 !== 0) {
					throw InvocationError.rpc(400, 'OFFSET_INVALID');
				}
				const bytes = this.documents.get(location.id.toString())!.subarray(offset, offset + limit);
				return { _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: 0, bytes };
			}
			default:
				throw new Error(`fake Telegram has no ${request._}`);
		}
	}

	private sentCode(phoneCodeHash: string): tl.auth.RawSentCode {
		return {
			_: 'auth.sentCode',
			type: { _: 'auth.sentCodeTypeApp', length: 5 },
			nextType: { _: 'auth.codeTypeSms' },
			phoneCodeHash,
			timeout: 60
		};
	}

	private signIn(): tl.auth.RawAuthorization {
		this.authorized = true;
		return { _: 'auth.authorization', user: this.user };
	}

	private send(request: tl.messages.RawSendMediaRequest): tl.TypeUpdates {
		if (request.media._ !== 'inputMediaUploadedDocument') throw new Error('expected a document');
		const { file, mimeType } = request.media;
		if (file._ !== 'inputFile' && file._ !== 'inputFileBig') throw new Error('expected a file');

		const upload = this.uploads.get(file.id.toString());
		if (upload?.parts.size !== file.parts) throw InvocationError.rpc(400, 'FILE_PARTS_INVALID');
		if ((upload.method === 'small') !== (file._ === 'inputFile')) {
			throw InvocationError.rpc(400, 'MEDIA_INVALID');
		}
		const bytes = Buffer.concat(Array.from({ length: file.parts }, (_, i) => upload.parts.get(i)!));
		if (file._ === 'inputFile') {
			const md5 = createHash('md5').update(bytes).digest('hex');
			if (md5 !== file.md5Checksum) throw InvocationError.rpc(400, 'MD5_CHECKSUM_INVALID');
		}
		this.uploads.delete(file.id.toString());

		const id = this.addDocument(file.name, bytes, { caption: request.message, mimeType });
		return {
			_: 'updates',
			updates: [{ _: 'updateMessageID', id, randomId: request.randomId }],
			users: [],
			chats: [],
			date: 1,
			seq: 0
		};
	}

	private dialogs(request: tl.messages.RawGetDialogsRequest) {
		const all = Array.from({ length: this.dialogsBefore }, (_, i) => ({
			_: 'dialog',
			peer: { _: 'peerUser', userId: i + 1 },
			topMessage: i + 1
		})) as { _: string; peer: tl.TypePeer; topMessage: number }[];
		if (this.member) all.push({ _: 'dialog', peer: this.peer, topMessage: 999999 });

		const offset = request.offsetPeer._ === 'inputPeerUser' ? request.offsetPeer.userId : 0;
		const dialogs = all.slice(offset, offset + request.limit);
		return {
			_: 'messages.dialogsSlice',
			count: all.length,
			dialogs,
			messages: [],
			users: [],
			chats: [this.chat]
		};
	}
}

class FakeTransport implements Transport {
	closed = false;

	constructor(
		private readonly telegram: FakeTelegram,
		private readonly setHomeDc: (id: number) => void
	) {}

	async invoke<T extends tl.RpcMethod>(
		request: T,
		options: InvokeOptions = {}
	): Promise<tl.RpcCallReturn[T['_']]> {
		if (this.closed) throw InvocationError.dropped();
		return (await this.telegram.handle(request, options)) as tl.RpcCallReturn[T['_']];
	}

	async changeHomeDc(id: number): Promise<void> {
		this.setHomeDc(id);
	}

	async computeSrp(
		_password: tl.account.RawPassword,
		input: string
	): Promise<tl.RawInputCheckPasswordSRP> {
		return {
			_: 'inputCheckPasswordSRP',
			srpId: Long.ONE,
			A: Buffer.from(input),
			M1: new Uint8Array(32)
		};
	}

	async notifyLoggedIn(): Promise<void> {}

	async close(): Promise<void> {
		this.closed = true;
	}
}
