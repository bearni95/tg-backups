// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BufferSource } from '../../src/lib/server/telegram/byte-source';
import type { BackupGroup } from '../../src/lib/server/telegram/backup-group';
import { InvocationError } from '../../src/lib/server/telegram/invocation-error';
import { walkAndMint } from '../../src/lib/server/telegram/reconcile';
import { call, useBackend } from './support/harness';

const backend = useBackend();

function upload(group: BackupGroup, content = 'backup') {
	const bytes = Buffer.from(content);
	return group.files.uploadSource(
		{ name: 'db.zip', mimeType: 'application/zip', totalSize: bytes.length },
		new BufferSource(bytes)
	);
}

function refuse(error = InvocationError.rpc(403, 'MESSAGE_DELETE_FORBIDDEN')) {
	backend.telegram.intercept = (request) => {
		if (request._ === 'channels.deleteMessages' || request._ === 'messages.deleteMessages')
			throw error;
	};
}

/** A 150-message backup, which takes two delete calls. */
function seedLarge(group: BackupGroup): number[] {
	const ids = Array.from({ length: 150 }, (_, i) =>
		backend.telegram.addDocument(`part${i}`, Buffer.from([i]))
	);
	group.db.insert({
		id: 'large',
		name: 'large.zip',
		sizeBytes: 150,
		mimeType: 'application/zip',
		tgMessageId: ids[0],
		text: null,
		checksumSha256: 'sum',
		metadata: null
	});
	ids.forEach((tgMessageId, ord) =>
		group.db.insertPart('large', { ord, tgMessageId, sizeBytes: 1, checksumSha256: null })
	);
	return ids;
}

describe('delete tells the truth', () => {
	it('keeps a backup Telegram refused to delete', async () => {
		const group = await backend.group();
		const { id } = await upload(group);
		refuse();
		await expect(group.files.delete(id)).rejects.toMatchObject({
			code: 'delete_failed',
			status: 409
		});
		expect(group.db.isComplete(group.db.get(id)!)).toBe(true);
		expect(group.db.get(id)!.checksumSha256).not.toBeNull();
		expect(backend.telegram.messages).toHaveLength(1);
	});

	it('works in a basic group too', async () => {
		backend.telegram.basicGroup = true;
		const group = await backend.group();
		const { id } = await upload(group);
		refuse();
		await expect(group.files.delete(id)).rejects.toMatchObject({ code: 'delete_failed' });
		expect(group.db.get(id)).not.toBeNull();
	});

	it('catches a refusal that comes back as success', async () => {
		const group = await backend.group();
		const { id, tgMessageId } = await upload(group);
		backend.telegram.undeletable.add(tgMessageId);
		await expect(group.files.delete(id)).rejects.toMatchObject({ code: 'delete_failed' });
		expect(group.db.get(id)).not.toBeNull();
	});

	it('reports it over HTTP', async () => {
		const storage = await backend.signedIn();
		const group = await storage.groups.resolve(null);
		const { id } = await upload(group);
		refuse();
		const response = await call(storage, 'DELETE', `/api/telegram/files/${id}`);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: 'delete_failed',
			error: expect.stringContaining('only the uploader or a group admin')
		});
	});

	it('succeeds when the reply was lost but the messages are gone', async () => {
		const group = await backend.group();
		const { id, tgMessageId } = await upload(group);
		backend.telegram.intercept = (request) => {
			if (request._ !== 'channels.deleteMessages') return;
			backend.telegram.remove(tgMessageId);
			throw InvocationError.transport('connection reset');
		};
		await group.files.delete(id);
		expect(group.db.get(id)).toBeNull();
	});

	it('succeeds when someone already deleted the messages', async () => {
		const group = await backend.group();
		const { id, tgMessageId } = await upload(group);
		backend.telegram.remove(tgMessageId);
		await group.files.delete(id);
		expect(group.db.get(id)).toBeNull();
	});

	it('keeps it when the result cannot be checked', async () => {
		const group = await backend.group();
		const { id } = await upload(group);
		backend.telegram.intercept = (request) => {
			if (request._ === 'channels.getMessages') throw InvocationError.rpc(500, 'INTERNAL');
		};
		await expect(group.files.delete(id)).rejects.toThrow();
		expect(group.db.get(id)).not.toBeNull();
	});

	it('passes a long flood wait on as one', async () => {
		const group = await backend.group();
		const { id } = await upload(group);
		refuse(InvocationError.rpc(420, 'FLOOD_WAIT_300'));
		await expect(group.files.delete(id)).rejects.toMatchObject({ code: 'rate_limited' });
		expect(group.db.get(id)).not.toBeNull();
	});

	it('shows a half-deleted backup as incomplete and resumable, then finishes on a retry', async () => {
		const group = await backend.group();
		seedLarge(group);
		let calls = 0;
		backend.telegram.intercept = (request) => {
			if (request._ === 'channels.deleteMessages' && ++calls === 2) {
				throw InvocationError.rpc(403, 'MESSAGE_DELETE_FORBIDDEN');
			}
		};
		await expect(group.files.delete('large')).rejects.toThrow('50 of 150');
		const row = group.db.get('large')!;
		expect(group.db.isComplete(row)).toBe(false);
		expect(group.db.findResumable('large.zip', 150)?.id).toBe('large');
		await expect(group.files.download('large')).rejects.toMatchObject({
			code: 'backup_incomplete'
		});

		backend.telegram.intercept = null;
		await group.files.delete('large');
		expect(group.db.get('large')).toBeNull();
		expect(backend.telegram.messages).toEqual([]);
	});

	it('stops at the first refused batch', async () => {
		const group = await backend.group();
		seedLarge(group);
		refuse();
		await expect(group.files.delete('large')).rejects.toMatchObject({ code: 'delete_failed' });
		expect(backend.telegram.count('channels.deleteMessages')).toBe(1);
		expect(group.db.isComplete(group.db.get('large')!)).toBe(true);
	});

	it('forgets staged copies of what it deleted', async () => {
		const group = await backend.group();
		const ids = seedLarge(group);
		group.db.upsertPendingPart({
			groupId: 'other',
			ord: 0,
			tgMessageId: ids[0],
			sizeBytes: 1,
			partChecksum: null,
			total: 9,
			name: 'x.zip',
			declaredSize: 9,
			mime: 'application/zip',
			caption: null,
			checksum: null,
			metadata: null
		});
		await group.files.delete('large');
		expect(group.db.loadPendingChunks()).toEqual([]);
	});

	it('stays gone after a fresh walk', async () => {
		const group = await backend.group();
		const { id } = await upload(group);
		await group.files.delete(id);
		expect(await walkAndMint(group, { kind: 'all' })).toEqual([]);
	});
});

describe('delete-all tells the truth', () => {
	it('keeps only what is still in the group', async () => {
		const group = await backend.group();
		const gone = await upload(group, 'one');
		const kept = await upload(group, 'two');
		backend.telegram.undeletable.add(kept.tgMessageId);
		await expect(group.files.deleteAll()).rejects.toMatchObject({ code: 'delete_failed' });
		expect(group.db.get(gone.id)).toBeNull();
		expect(group.db.get(kept.id)).not.toBeNull();
	});

	it('is not failed by service messages, which cannot be deleted', async () => {
		const group = await backend.group();
		await upload(group);
		backend.telegram.messages.push({
			_: 'messageService',
			id: 900,
			peerId: backend.telegram.peer,
			date: 1,
			action: { _: 'messageActionChannelCreate', title: 'tgb' }
		});
		backend.telegram.intercept = (request) => {
			if (request._ === 'channels.deleteMessages' && request.id.includes(900)) {
				throw InvocationError.rpc(403, 'MESSAGE_DELETE_FORBIDDEN');
			}
		};
		expect(await group.files.deleteAll()).toBe(1);
		expect(group.db.list()).toEqual([]);
	});
});

describe('a damaged upload that cannot be removed', () => {
	it('says it is still listed', async () => {
		const group = await backend.group();
		refuse();
		const source = new BufferSource(Buffer.alloc(100, 1));
		const read = source.read.bind(source);
		let reads = 0;
		source.read = async (length) => {
			const piece = await read(length);
			if (++reads > 1) piece.fill(0);
			return piece;
		};
		await expect(
			group.files.uploadSource(
				{ name: 'db.zip', mimeType: 'application/zip', totalSize: 100 },
				source
			)
		).rejects.toMatchObject({
			code: 'checksum_mismatch',
			message: expect.stringContaining('still listed')
		});
		expect(group.db.list()).toHaveLength(1);
	});
});
