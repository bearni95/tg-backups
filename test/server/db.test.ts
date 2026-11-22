// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexDb, timestamp } from '../../src/lib/server/telegram/db';
import { multipartGroupKey } from '../../src/lib/server/telegram/reconcile';
import type { FileRow, MintGroup } from '../../src/types/telegram-server.type';

let root: string;
let path: string;
let db: IndexDb;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'tgb-db-'));
	path = join(root, 'index.sqlite');
	db = new IndexDb(path);
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

function insert(id: string, change: Partial<FileRow> = {}) {
	db.insert({
		id,
		name: 'f.zip',
		sizeBytes: 100,
		mimeType: 'application/zip',
		tgMessageId: 10,
		text: null,
		checksumSha256: null,
		metadata: null,
		...change
	});
}

function part(
	id: string,
	ord: number,
	tgMessageId: number,
	sizeBytes = 50,
	sum: string | null = null
) {
	db.insertPart(id, { ord, tgMessageId, sizeBytes, checksumSha256: sum });
}

function stage(groupId: string, ord: number, tgMessageId: number) {
	db.upsertPendingPart({
		groupId,
		ord,
		tgMessageId,
		sizeBytes: 100,
		partChecksum: null,
		total: 3,
		name: 'Movie.zip',
		declaredSize: 300,
		mime: 'application/zip',
		caption: null,
		checksum: null,
		metadata: null
	});
}

const group: MintGroup = {
	name: 'Movie.zip',
	finalSize: 300,
	mime: 'application/zip',
	caption: null,
	checksum: 'full',
	metadata: null,
	chunks: [46, 100, 159].map((tgMessageId, ord) => ({
		ord,
		tgMessageId,
		sizeBytes: 100,
		checksumSha256: null
	}))
};

describe('files', () => {
	it('round-trips every column', () => {
		insert('id1', { text: 'caption', checksumSha256: 'abcd', metadata: '{"k":"x"}' });
		expect(db.get('id1')).toMatchObject({
			id: 'id1',
			name: 'f.zip',
			sizeBytes: 100,
			mimeType: 'application/zip',
			tgMessageId: 10,
			text: 'caption',
			checksumSha256: 'abcd',
			metadata: '{"k":"x"}'
		});
	});

	it('lists newest first', async () => {
		insert('a');
		await new Promise((resolve) => setTimeout(resolve, 5));
		insert('b');
		expect(db.list().map((row) => row.id)).toEqual(['b', 'a']);
	});

	it('finds by name, checksum and message', () => {
		insert('id1', { name: 'db.zip', checksumSha256: 'hex', tgMessageId: 5 });
		expect(db.findByName('db.zip')?.id).toBe('id1');
		expect(db.findByName('missing.zip')).toBeNull();
		expect(db.findByChecksum('hex')?.id).toBe('id1');
		expect(db.findByChecksum('nope')).toBeNull();
		expect(db.findByMessageId(5)?.id).toBe('id1');
		expect(db.findByMessageId(999)).toBeNull();
	});

	it('resumes only unfinished uploads of the same size', () => {
		insert('done', { checksumSha256: 'fullhash' });
		expect(db.findResumable('f.zip', 100)).toBeNull();
		insert('partial');
		expect(db.findResumable('f.zip', 100)?.id).toBe('partial');
		expect(db.findResumable('f.zip', 99)).toBeNull();
	});

	it('resumes the attempt with most chunks landed', () => {
		insert('few');
		part('few', 0, 1);
		insert('many');
		part('many', 0, 2);
		part('many', 1, 3);
		expect(db.findResumable('f.zip', 100)?.id).toBe('many');
	});

	it('finds media by pipeline id', () => {
		insert('sidecar', { metadata: '{"pipelineId":"p1","role":"metadata"}' });
		insert('nested', { metadata: '{"other":{"pipelineId":"p1"}}' });
		expect(db.findMediaByPipelineId('p1')).toBeNull();
		insert('media', { metadata: '{"pipelineId":"p1","role":"media"}' });
		expect(db.findMediaByPipelineId('p1')?.id).toBe('media');
	});

	it('updates the checksum and the head message', () => {
		insert('id1');
		db.setChecksum('id1', 'newhex');
		db.updateHeadMessageId('id1', 77);
		expect(db.get('id1')).toMatchObject({ checksumSha256: 'newhex', tgMessageId: 77 });
	});

	it('deletes once', () => {
		insert('id1');
		expect(db.delete('id1')).toBe(true);
		expect(db.delete('id1')).toBe(false);
		expect(db.get('id1')).toBeNull();
	});

	it('clears files, parts and staging', () => {
		insert('id1');
		part('id1', 0, 1);
		stage('g', 0, 2);
		db.clearAll();
		expect(db.list()).toEqual([]);
		expect(db.listParts('id1')).toEqual([]);
		expect(db.loadPendingChunks()).toEqual([]);
	});
});

describe('parts', () => {
	it('lists in order and knows its messages', () => {
		insert('id1');
		part('id1', 1, 11, 50, 'p1');
		part('id1', 0, 10, 50, 'p0');
		expect(db.listParts('id1').map((row) => row.checksumSha256)).toEqual(['p0', 'p1']);
		expect(db.partMessageIdExists(11)).toBe(true);
		expect(db.partMessageIdExists(999)).toBe(false);
	});

	it('sums the bytes that landed', () => {
		expect(db.partsTotalSize('missing')).toBe(0);
		insert('id1');
		expect(db.partsTotalSize('id1')).toBe(0);
		part('id1', 0, 10, 50);
		expect(db.isComplete(db.get('id1')!)).toBe(false);
		part('id1', 1, 11, 50);
		expect(db.partsTotalSize('id1')).toBe(100);
		expect(db.isComplete(db.get('id1')!)).toBe(true);
	});

	it('upserts a re-pushed chunk', () => {
		insert('id1');
		part('id1', 0, 10, 50, 'old');
		part('id1', 0, 99, 60, 'new');
		expect(db.listParts('id1')).toEqual([
			{ ord: 0, tgMessageId: 99, sizeBytes: 60, checksumSha256: 'new' }
		]);
	});

	it('enforces the foreign key', () => {
		expect(() => part('nobody', 0, 1)).toThrow();
	});
});

describe('staging and minting', () => {
	it('accumulates chunks across walks', () => {
		stage('g1', 0, 46);
		stage('g1', 2, 159);
		expect(db.loadPendingChunks()).toHaveLength(2);
		stage('g1', 0, 46);
		stage('g1', 1, 100);
		expect(db.loadPendingChunks().map((chunk) => chunk.ord)).toEqual([0, 1, 2]);
		db.deletePendingGroup('g1');
		expect(db.loadPendingChunks()).toEqual([]);
	});

	it('clears fragments staged under other group ids', () => {
		['a', 'b', 'c'].forEach((id, ord) => stage(id, ord, 46 + ord));
		db.deletePendingGroup('a');
		expect(db.loadPendingChunks()).toHaveLength(2);
		db.deletePendingByIdentity('Movie.zip', 300, 3);
		expect(db.loadPendingChunks()).toEqual([]);
	});

	it('stores group keys whole, NUL separators included', () => {
		const a = multipartGroupKey('Movie.zip', 300, 3);
		const b = multipartGroupKey('Movie.zip', 301, 3);
		stage(a, 0, 1);
		stage(b, 0, 2);
		expect(
			db
				.loadPendingChunks()
				.map((chunk) => chunk.groupId)
				.sort()
		).toEqual([a, b].sort());
	});

	it('mints once', () => {
		const id = db.healAndMint(group)!;
		expect(db.get(id)?.tgMessageId).toBe(46);
		expect(db.listParts(id)).toHaveLength(3);
		expect(db.healAndMint(group)).toBeNull();
	});

	it('purges a broken partial mint first', () => {
		insert('broken', { tgMessageId: 46, sizeBytes: 200 });
		part('broken', 0, 46, 100);
		part('broken', 1, 100, 100);
		const id = db.healAndMint(group)!;
		expect(id).not.toBe('broken');
		expect(db.get('broken')).toBeNull();
		expect(db.completeFileExists(46, 3)).toBe(true);
		expect(db.list()).toHaveLength(1);
	});
});

describe('existing databases', () => {
	it('migrates idempotently', () => {
		db.migrate();
		db.migrate();
		expect(db.list()).toEqual([]);
	});

	it('gives rows from before the parts table one part', () => {
		insert('legacy', { tgMessageId: 7, sizeBytes: 5 });
		expect(db.listParts('legacy')).toEqual([]);
		db.migrate();
		expect(db.listParts('legacy')).toEqual([
			{ ord: 0, tgMessageId: 7, sizeBytes: 5, checksumSha256: null }
		]);
	});

	it('upgrades a database from before the added columns', () => {
		const legacyPath = join(root, 'legacy.sqlite');
		const legacy = new DatabaseSync(legacyPath);
		legacy.exec(`
			CREATE TABLE tg_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size_bytes INTEGER NOT NULL,
				mime_type TEXT NOT NULL, tg_message_id INTEGER NOT NULL, created_at TEXT NOT NULL);
			INSERT INTO tg_files VALUES ('old', 'old.zip', 5, 'application/zip', 7, '2025-01-01T00:00:00+00:00');
		`);
		legacy.close();

		const upgraded = new IndexDb(legacyPath);
		expect(upgraded.get('old')).toMatchObject({ checksumSha256: null, metadata: null, text: null });
		expect(upgraded.listParts('old')).toHaveLength(1);
		upgraded.close();
	});

	it('reads and sorts nanosecond timestamps beside new rows', () => {
		const raw = new DatabaseSync(path);
		raw.exec(`
			INSERT INTO tg_files VALUES ('earlier', 'a.zip', 1, 'application/zip', 1, '2020-03-01T10:00:00.123456789+00:00', NULL, NULL, NULL);
			INSERT INTO tg_files VALUES ('later', 'b.zip', 1, 'application/zip', 2, '2020-03-01T10:00:00.987654+00:00', NULL, NULL, NULL);
		`);
		raw.close();
		insert('new');
		expect(db.list().map((row) => row.id)).toEqual(['new', 'later', 'earlier']);
		expect(db.get('earlier')?.createdAt).toBe('2020-03-01T10:00:00.123456789+00:00');
	});

	it('writes integers as integers', () => {
		insert('id1');
		const raw = new DatabaseSync(path);
		expect({
			...raw.prepare('SELECT typeof(size_bytes) s, typeof(tg_message_id) m FROM tg_files').get()
		}).toEqual({ s: 'integer', m: 'integer' });
		raw.close();
	});

	it('stamps the same format', () => {
		expect(timestamp(new Date('2026-11-22T10:00:00.000Z'))).toBe('2026-11-22T10:00:00+00:00');
		expect(timestamp(new Date('2026-11-22T10:00:00.120Z'))).toBe('2026-11-22T10:00:00.120+00:00');
	});
});
