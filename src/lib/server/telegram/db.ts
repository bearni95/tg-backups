// The SQLite index of the group. Schema and value formats match what is already
// on disk, so an existing index.sqlite opens as is.
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { asObject } from '$utils/json/losslessJson';
import { telegramFileAdapter } from '$adapters/classes/telegram-file.adapter';
import type { FilePart, FileRow, MintGroup, PendingChunk } from '$types/telegram-server.type';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_files (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    mime_type        TEXT NOT NULL,
    tg_message_id    INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    text             TEXT,
    checksum_sha256  TEXT,
    metadata         TEXT
);

CREATE INDEX IF NOT EXISTS idx_tg_files_created_at ON tg_files(created_at DESC);

CREATE TABLE IF NOT EXISTS tg_file_part (
    tg_file_id       TEXT NOT NULL REFERENCES tg_files(id) ON DELETE CASCADE,
    ord              INTEGER NOT NULL,
    tg_message_id    INTEGER NOT NULL,
    size_bytes       INTEGER NOT NULL,
    checksum_sha256  TEXT,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (tg_file_id, ord)
);

CREATE INDEX IF NOT EXISTS idx_tg_file_part_message ON tg_file_part(tg_message_id);

CREATE TABLE IF NOT EXISTS tg_pending_part (
    group_id         TEXT NOT NULL,
    ord              INTEGER NOT NULL,
    tg_message_id    INTEGER NOT NULL,
    size_bytes       INTEGER NOT NULL,
    part_checksum    TEXT,
    total            INTEGER NOT NULL,
    name             TEXT NOT NULL,
    declared_size    INTEGER NOT NULL,
    mime             TEXT NOT NULL,
    caption          TEXT,
    checksum         TEXT,
    metadata         TEXT,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (group_id, ord)
);
`;

const FILE_COLUMNS = `id, name, size_bytes AS sizeBytes, mime_type AS mimeType,
	tg_message_id AS tgMessageId, created_at AS createdAt,
	text, checksum_sha256 AS checksumSha256, metadata`;

/** RFC 3339 with `+00:00`, as existing rows have it: `created_at` is sorted as text. */
export function timestamp(date: Date = new Date()): string {
	return date.toISOString().replace('.000Z', 'Z').replace('Z', '+00:00');
}

export class IndexDb {
	private readonly db: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();

	constructor(path: string) {
		this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
		this.db.exec('PRAGMA busy_timeout = 5000');
		this.migrate();
	}

	/** Safe to run on every boot, on new and old databases alike. */
	migrate(): void {
		this.db.exec(SCHEMA);
		this.ensureColumn('tg_files', 'text', 'TEXT');
		this.ensureColumn('tg_files', 'checksum_sha256', 'TEXT');
		this.ensureColumn('tg_files', 'metadata', 'TEXT');
		this.ensureColumn('tg_file_part', 'checksum_sha256', 'TEXT');
		// Not in SCHEMA: an old table only gets this column above.
		this.db.exec('CREATE INDEX IF NOT EXISTS idx_tg_files_checksum ON tg_files(checksum_sha256)');
		// Rows older than the parts table become single-part files.
		this.db.exec(`
			INSERT OR IGNORE INTO tg_file_part (tg_file_id, ord, tg_message_id, size_bytes, created_at)
			SELECT id, 0, tg_message_id, size_bytes, created_at
			FROM tg_files
			WHERE NOT EXISTS (SELECT 1 FROM tg_file_part WHERE tg_file_part.tg_file_id = tg_files.id)
		`);
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}

	list(): FileRow[] {
		return this.all<FileRow>(`SELECT ${FILE_COLUMNS} FROM tg_files ORDER BY created_at DESC`);
	}

	get(id: string): FileRow | null {
		return this.one<FileRow>(`SELECT ${FILE_COLUMNS} FROM tg_files WHERE id = ?`, id);
	}

	findByName(name: string): FileRow | null {
		return this.one<FileRow>(`SELECT ${FILE_COLUMNS} FROM tg_files WHERE name = ? LIMIT 1`, name);
	}

	findByChecksum(checksum: string): FileRow | null {
		return this.one<FileRow>(
			`SELECT ${FILE_COLUMNS} FROM tg_files WHERE checksum_sha256 = ? LIMIT 1`,
			checksum
		);
	}

	findByMessageId(messageId: number): FileRow | null {
		return this.one<FileRow>(
			`SELECT ${FILE_COLUMNS} FROM tg_files WHERE tg_message_id = ? LIMIT 1`,
			messageId
		);
	}

	/**
	 * An unfinished upload of the same logical file: same stored name and size,
	 * no full-file checksum yet. Prefers the one with the most chunks landed.
	 */
	findResumable(name: string, sizeBytes: number): FileRow | null {
		return this.one<FileRow>(
			`SELECT ${FILE_COLUMNS} FROM tg_files
			 WHERE name = ? AND size_bytes = ? AND checksum_sha256 IS NULL
			 ORDER BY (SELECT COUNT(*) FROM tg_file_part p WHERE p.tg_file_id = tg_files.id) DESC,
			          created_at DESC
			 LIMIT 1`,
			name,
			sizeBytes
		);
	}

	/** The newest row with this `pipelineId` that isn't a metadata sidecar. */
	findMediaByPipelineId(pipelineId: string): FileRow | null {
		// LIKE narrows the scan; the parsed JSON decides.
		const rows = this.all<FileRow>(
			`SELECT ${FILE_COLUMNS} FROM tg_files WHERE metadata LIKE ? ORDER BY created_at DESC`,
			`%"pipelineId":"${pipelineId}"%`
		);
		for (const row of rows) {
			const metadata = asObject(telegramFileAdapter.metadataFromRow(row));
			if (metadata?.pipelineId === pipelineId && metadata.role !== 'metadata') return row;
		}
		return null;
	}

	insert(file: Omit<FileRow, 'createdAt'>): void {
		this.run(
			`INSERT INTO tg_files
			     (id, name, size_bytes, mime_type, tg_message_id, created_at, text, checksum_sha256, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			file.id,
			file.name,
			file.sizeBytes,
			file.mimeType,
			file.tgMessageId,
			timestamp(),
			file.text,
			file.checksumSha256,
			file.metadata
		);
	}

	updateHeadMessageId(id: string, messageId: number): void {
		this.run('UPDATE tg_files SET tg_message_id = ? WHERE id = ?', messageId, id);
	}

	setChecksum(id: string, checksum: string): void {
		this.run('UPDATE tg_files SET checksum_sha256 = ? WHERE id = ?', checksum, id);
	}

	delete(id: string): boolean {
		return this.run('DELETE FROM tg_files WHERE id = ?', id) > 0;
	}

	clearAll(): void {
		// Parts go with their file by cascade.
		this.run('DELETE FROM tg_files');
		this.run('DELETE FROM tg_pending_part');
	}

	/** Upserts, so a re-pushed chunk replaces its stale row. */
	insertPart(fileId: string, part: FilePart): void {
		this.run(
			`INSERT INTO tg_file_part
			     (tg_file_id, ord, tg_message_id, size_bytes, checksum_sha256, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(tg_file_id, ord) DO UPDATE SET
			     tg_message_id = excluded.tg_message_id,
			     size_bytes = excluded.size_bytes,
			     checksum_sha256 = excluded.checksum_sha256,
			     created_at = excluded.created_at`,
			fileId,
			part.ord,
			part.tgMessageId,
			part.sizeBytes,
			part.checksumSha256,
			timestamp()
		);
	}

	listParts(fileId: string): FilePart[] {
		return this.all<FilePart>(
			`SELECT ord, tg_message_id AS tgMessageId, size_bytes AS sizeBytes,
			        checksum_sha256 AS checksumSha256
			 FROM tg_file_part WHERE tg_file_id = ? ORDER BY ord ASC`,
			fileId
		);
	}

	/** Bytes that have landed on Telegram. */
	partsTotalSize(fileId: string): number {
		const row = this.one<{ total: number }>(
			'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM tg_file_part WHERE tg_file_id = ?',
			fileId
		);
		return Math.max(0, row?.total ?? 0);
	}

	isComplete(file: FileRow): boolean {
		return this.partsTotalSize(file.id) === Math.max(0, file.sizeBytes);
	}

	partMessageIdExists(messageId: number): boolean {
		const sql = 'SELECT 1 FROM tg_file_part WHERE tg_message_id = ? LIMIT 1';
		return this.one(sql, messageId) !== null;
	}

	// One walk of the group may not see every chunk of a backup, so incomplete
	// groups are staged here and accumulate across walks.

	upsertPendingPart(chunk: PendingChunk): void {
		this.run(
			`INSERT INTO tg_pending_part
			     (group_id, ord, tg_message_id, size_bytes, part_checksum, total,
			      name, declared_size, mime, caption, checksum, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(group_id, ord) DO UPDATE SET
			     tg_message_id = excluded.tg_message_id,
			     size_bytes = excluded.size_bytes,
			     part_checksum = COALESCE(excluded.part_checksum, tg_pending_part.part_checksum),
			     total = excluded.total,
			     name = excluded.name,
			     declared_size = excluded.declared_size,
			     mime = excluded.mime,
			     caption = COALESCE(excluded.caption, tg_pending_part.caption),
			     checksum = COALESCE(excluded.checksum, tg_pending_part.checksum),
			     metadata = COALESCE(excluded.metadata, tg_pending_part.metadata)`,
			chunk.groupId,
			chunk.ord,
			chunk.tgMessageId,
			chunk.sizeBytes,
			chunk.partChecksum,
			chunk.total,
			chunk.name,
			chunk.declaredSize,
			chunk.mime,
			chunk.caption,
			chunk.checksum,
			chunk.metadata,
			timestamp()
		);
	}

	loadPendingChunks(): PendingChunk[] {
		return this.all<PendingChunk>(
			`SELECT group_id AS groupId, ord, tg_message_id AS tgMessageId, size_bytes AS sizeBytes,
			        part_checksum AS partChecksum, total, name, declared_size AS declaredSize,
			        mime, caption, checksum, metadata
			 FROM tg_pending_part ORDER BY group_id, ord`
		);
	}

	deletePendingGroup(groupId: string): void {
		this.run('DELETE FROM tg_pending_part WHERE group_id = ?', groupId);
	}

	/** By identity, so fragments staged under other group ids go as well. */
	deletePendingByIdentity(name: string, declaredSize: number, total: number): void {
		this.run(
			'DELETE FROM tg_pending_part WHERE name = ? AND declared_size = ? AND total = ?',
			name,
			declaredSize,
			total
		);
	}

	completeFileExists(headMessageId: number, total: number): boolean {
		const row = this.one(
			`SELECT 1 FROM tg_files f
			 WHERE f.tg_message_id = ?
			   AND (SELECT COUNT(*) FROM tg_file_part p WHERE p.tg_file_id = f.id) = ?
			 LIMIT 1`,
			headMessageId,
			total
		);
		return row !== null;
	}

	/**
	 * Mint a complete group. A healthy file keeps its id (returns null); a broken
	 * earlier mint is purged first, or its rows would hide those chunks for good.
	 */
	healAndMint(group: MintGroup): string | null {
		const head = group.chunks[0]?.tgMessageId ?? 0;
		if (this.completeFileExists(head, group.chunks.length)) return null;

		for (const chunk of group.chunks) {
			this.run('DELETE FROM tg_file_part WHERE tg_message_id = ?', chunk.tgMessageId);
		}
		this.run('DELETE FROM tg_files WHERE tg_message_id = ?', head);

		const id = randomUUID();
		this.insert({
			id,
			name: group.name,
			sizeBytes: group.finalSize,
			mimeType: group.mime,
			tgMessageId: head,
			text: group.caption,
			checksumSha256: group.checksum,
			metadata: group.metadata
		});
		for (const chunk of group.chunks) this.insertPart(id, chunk);
		return id;
	}

	private ensureColumn(table: string, column: string, type: string): void {
		const columns = this.db.prepare(`PRAGMA table_info("${table}")`).all();
		if (columns.some((existing) => existing.name === column)) return;
		this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
	}

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		// Spread: node:sqlite rows have no prototype.
		return this.statement(sql)
			.all(...params)
			.map((row) => ({ ...row }) as T);
	}

	private one<T>(sql: string, ...params: SQLInputValue[]): T | null {
		const row = this.statement(sql).get(...params);
		return row ? ({ ...row } as T) : null;
	}

	private run(sql: string, ...params: SQLInputValue[]): number {
		return Number(this.statement(sql).run(...params).changes);
	}
}
