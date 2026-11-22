//! SQLite tables for the Telegram storage index.
//!
//! Two tables, both keyed by a uuid `tg_files.id`:
//!
//! - `tg_files` — one row per logical file. Carries the total size,
//!   the full-file SHA-256, an optional caller-supplied JSON `metadata`
//!   blob (the schema is deliberately opaque — the storage crate doesn't
//!   interpret it), and the message id of the **first** chunk so legacy
//!   readers that only knew about `tg_message_id` keep working.
//! - `tg_file_part` — one row per Telegram message that holds a slice
//!   of the bytes. Concatenating part bytes in `ord` order reproduces
//!   the original file. Each part also carries its own SHA-256 so a
//!   torn chunk can be detected mid-stream without redownloading the
//!   whole file.
//! - `tg_pending_part` — staging for a multipart file being reconstructed
//!   from a chat walk. A file only mints into `tg_files` once every chunk
//!   is present, but a single walk isn't guaranteed to observe them all
//!   (interleaved concurrent uploads, a bounded/interrupted walk, a
//!   rate-limited mobile client). Each observed chunk is upserted here
//!   keyed by `(group_id, ord)`, so observations **accumulate across
//!   walks** until the group is complete and can be minted — then its
//!   staging rows are cleared. This is what makes a second device (esp.
//!   Android) reliably recover a file whose chunks it can't see in one
//!   pass, instead of stranding it forever.
//!
//! Folder hierarchy is deferred until v2.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, Row};

use crate::error::StorageError;
use crate::pool::Db;

/// Schema applied on every open. Idempotent (`IF NOT EXISTS`) so
/// re-running it on existing databases is a no-op. Columns added
/// after the initial release (`text`, `checksum_sha256`, `metadata`,
/// `tg_file_part.checksum_sha256`) are backfilled in [`migrate`] via
/// `PRAGMA table_info` probes because SQLite doesn't accept
/// `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
///
/// `metadata` is an opaque JSON blob — the storage crate never reads
/// it. Callers stamp whatever they need (firkin ids, source URLs,
/// custom tags) and read it back through [`FileRow::metadata`].
pub const SCHEMA: &str = r#"
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
CREATE INDEX IF NOT EXISTS idx_tg_files_checksum ON tg_files(checksum_sha256);

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
"#;

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub id: String,
    pub name: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub tg_message_id: i64,
    pub created_at: DateTime<Utc>,
    /// Legacy free-text caption mirrored from the Telegram message. New
    /// uploads populate the structured [`Self::metadata`] field instead;
    /// `text` stays for backwards compatibility with rows written before
    /// the metadata column existed.
    pub text: Option<String>,
    /// Hex-encoded SHA-256 of the full logical file. `None` for legacy
    /// rows or rows reconciled from a chat that predates the checksum
    /// marker — callers that require it should treat `None` as "unknown,
    /// recompute on demand" rather than fall over.
    pub checksum_sha256: Option<String>,
    /// Caller-supplied JSON blob. Stored as a string in SQLite so the
    /// column type stays simple; deserialised lazily via
    /// [`Self::metadata_value`].
    pub metadata: Option<String>,
}

impl FileRow {
    /// Parse the stored [`Self::metadata`] string as a JSON value. Returns
    /// `Ok(None)` when the column is NULL or empty; `Err` when the column
    /// holds invalid JSON (should never happen for rows the upload path
    /// wrote — it's only possible if someone hand-edits the DB).
    pub fn metadata_value(&self) -> Result<Option<serde_json::Value>, serde_json::Error> {
        match self.metadata.as_deref() {
            Some(s) if !s.is_empty() => serde_json::from_str(s).map(Some),
            _ => Ok(None),
        }
    }
}

pub async fn migrate(db: &Db) -> Result<(), StorageError> {
    sqlx::query(SCHEMA).execute(db.pool()).await?;
    ensure_column(db, "tg_files", "text", "TEXT").await?;
    ensure_column(db, "tg_files", "checksum_sha256", "TEXT").await?;
    ensure_column(db, "tg_files", "metadata", "TEXT").await?;
    ensure_column(db, "tg_file_part", "checksum_sha256", "TEXT").await?;
    backfill_parts(db).await?;
    Ok(())
}

/// Mint a single-part `tg_file_part` row for every `tg_files` row that
/// predates the parts table. Idempotent — `INSERT OR IGNORE` skips
/// rows already covered by parts. Lets the download path read uniformly
/// from `tg_file_part` without a legacy fallback.
async fn backfill_parts(db: &Db) -> Result<(), StorageError> {
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO tg_file_part (tg_file_id, ord, tg_message_id, size_bytes, created_at)
        SELECT id, 0, tg_message_id, size_bytes, created_at
        FROM tg_files
        WHERE NOT EXISTS (
            SELECT 1 FROM tg_file_part WHERE tg_file_part.tg_file_id = tg_files.id
        )
        "#,
    )
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Additive migration helper. SQLite forbids
/// `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so we probe
/// `pragma_table_info` first and only fire the ALTER when the column
/// is missing. Idempotent across reboots; safe on fresh and legacy DBs.
async fn ensure_column(
    db: &Db,
    table: &str,
    column: &str,
    sql_type: &str,
) -> Result<(), StorageError> {
    let pragma = format!(r#"PRAGMA table_info("{table}")"#);
    let cols: Vec<String> = sqlx::query(&pragma)
        .fetch_all(db.pool())
        .await?
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();
    if cols.iter().any(|c| c == column) {
        return Ok(());
    }
    let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {sql_type}");
    sqlx::query(&alter).execute(db.pool()).await?;
    Ok(())
}

pub async fn list(db: &Db) -> Result<Vec<FileRow>, StorageError> {
    let rows = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files ORDER BY created_at DESC",
    )
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

pub async fn get(db: &Db, id: &str) -> Result<Option<FileRow>, StorageError> {
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

pub async fn find_by_name(db: &Db, name: &str) -> Result<Option<FileRow>, StorageError> {
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files WHERE name = ?1 LIMIT 1",
    )
    .bind(name)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

/// Find an interrupted prior upload of the same logical file to resume:
/// same `name` + `size_bytes`, never completed (the full-file
/// `checksum_sha256` is still NULL — it's only set after the last chunk
/// lands). Prefers the candidate with the most chunks already on Telegram
/// so a resume skips as many re-pushes as possible. Returns `None` for a
/// genuinely fresh upload (no matching interrupted row), in which case the
/// caller mints a new id and uploads every chunk.
pub async fn find_resumable(
    db: &Db,
    name: &str,
    size_bytes: i64,
) -> Result<Option<FileRow>, StorageError> {
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files \
         WHERE name = ?1 AND size_bytes = ?2 AND checksum_sha256 IS NULL \
         ORDER BY (SELECT COUNT(*) FROM tg_file_part p WHERE p.tg_file_id = tg_files.id) DESC, \
                  created_at DESC \
         LIMIT 1",
    )
    .bind(name)
    .bind(size_bytes)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

pub async fn find_by_checksum(
    db: &Db,
    checksum_hex: &str,
) -> Result<Option<FileRow>, StorageError> {
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files WHERE checksum_sha256 = ?1 LIMIT 1",
    )
    .bind(checksum_hex)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

pub async fn find_by_tg_message_id(
    db: &Db,
    tg_message_id: i64,
) -> Result<Option<FileRow>, StorageError> {
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files WHERE tg_message_id = ?1 LIMIT 1",
    )
    .bind(tg_message_id)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

/// Insert a fresh `tg_files` row. `text` is the legacy free-text caption
/// (kept for backwards compat with the firkin reconciler); `checksum_sha256`
/// and `metadata` are the new structured fields written by the chunked
/// upload path.
#[allow(clippy::too_many_arguments)]
pub async fn insert(
    db: &Db,
    id: &str,
    name: &str,
    size_bytes: i64,
    mime_type: &str,
    tg_message_id: i64,
    text: Option<&str>,
    checksum_sha256: Option<&str>,
    metadata: Option<&str>,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO tg_files \
             (id, name, size_bytes, mime_type, tg_message_id, created_at, \
              text, checksum_sha256, metadata) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(id)
    .bind(name)
    .bind(size_bytes)
    .bind(mime_type)
    .bind(tg_message_id)
    .bind(Utc::now())
    .bind(text)
    .bind(checksum_sha256)
    .bind(metadata)
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Overwrite the `tg_files.tg_message_id` column on an existing row.
/// Used by the parallel upload path when a non-zero chunk lands before
/// chunk 0: the head row gets inserted with that chunk's id as a
/// placeholder so later `tg_file_part` inserts satisfy the FK, then
/// this UPDATE rewrites it to chunk 0's id once chunk 0 lands.
pub async fn update_head_message_id(
    db: &Db,
    id: &str,
    tg_message_id: i64,
) -> Result<(), StorageError> {
    sqlx::query("UPDATE tg_files SET tg_message_id = ?1 WHERE id = ?2")
        .bind(tg_message_id)
        .bind(id)
        .execute(db.pool())
        .await?;
    Ok(())
}

/// Set / replace the full-file SHA-256 on an existing row. Used by the
/// upload path which discovers the checksum only after the last chunk
/// has been streamed, and by the reconcile path when it parses a v2
/// marker that carries the digest.
pub async fn set_checksum(db: &Db, id: &str, checksum_sha256: &str) -> Result<(), StorageError> {
    sqlx::query("UPDATE tg_files SET checksum_sha256 = ?1 WHERE id = ?2")
        .bind(checksum_sha256)
        .bind(id)
        .execute(db.pool())
        .await?;
    Ok(())
}

pub async fn delete(db: &Db, id: &str) -> Result<bool, StorageError> {
    let result = sqlx::query("DELETE FROM tg_files WHERE id = ?1")
        .bind(id)
        .execute(db.pool())
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn clear_all(db: &Db) -> Result<(), StorageError> {
    // FK cascade drops `tg_file_part` rows alongside their parents.
    sqlx::query("DELETE FROM tg_files")
        .execute(db.pool())
        .await?;
    Ok(())
}

/// One part of a logical file. `ord` is the 0-based chunk index;
/// concatenating chunks in `ord` order reproduces the original bytes.
/// `checksum_sha256` is the hex-encoded SHA-256 of this chunk's bytes;
/// `None` for legacy rows backfilled by [`backfill_parts`].
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePart {
    pub tg_file_id: String,
    pub ord: i64,
    pub tg_message_id: i64,
    pub size_bytes: i64,
    pub checksum_sha256: Option<String>,
}

/// Insert (or replace) a single `tg_file_part` row. Called by the upload
/// path once per chunk after the Telegram message lands. Upserts on
/// `(tg_file_id, ord)` so a resumed upload that re-pushes a chunk whose
/// bytes changed (a torn / mismatched prior part) overwrites the stale row
/// with the fresh message id + checksum instead of hitting a PK conflict.
pub async fn insert_part(
    db: &Db,
    tg_file_id: &str,
    ord: i64,
    tg_message_id: i64,
    size_bytes: i64,
    checksum_sha256: Option<&str>,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO tg_file_part \
             (tg_file_id, ord, tg_message_id, size_bytes, checksum_sha256, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(tg_file_id, ord) DO UPDATE SET \
             tg_message_id = excluded.tg_message_id, \
             size_bytes = excluded.size_bytes, \
             checksum_sha256 = excluded.checksum_sha256, \
             created_at = excluded.created_at",
    )
    .bind(tg_file_id)
    .bind(ord)
    .bind(tg_message_id)
    .bind(size_bytes)
    .bind(checksum_sha256)
    .bind(Utc::now())
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Return every chunk for `tg_file_id`, ordered by `ord` ascending.
/// Empty for legacy rows that predate the parts table — but
/// [`migrate`] backfills those on every boot, so callers can treat an
/// empty result as "this id doesn't exist" without a legacy fallback.
pub async fn list_parts(db: &Db, tg_file_id: &str) -> Result<Vec<FilePart>, StorageError> {
    let rows = sqlx::query_as::<_, FilePart>(
        "SELECT tg_file_id, ord, tg_message_id, size_bytes, checksum_sha256 \
         FROM tg_file_part WHERE tg_file_id = ?1 ORDER BY ord ASC",
    )
    .bind(tg_file_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

/// Sum of `size_bytes` across every persisted `tg_file_part` row for
/// `tg_file_id`. While an upload is still in flight, this is the
/// **currently uploaded** byte tail — the highest offset the download
/// path can serve without short-reading. Returns `0` when no parts exist
/// yet (head row written but chunk 0 still mid-send) so callers don't
/// have to special-case the empty result.
pub async fn list_parts_total_size(db: &Db, tg_file_id: &str) -> Result<u64, StorageError> {
    let row: (Option<i64>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM tg_file_part WHERE tg_file_id = ?1",
    )
    .bind(tg_file_id)
    .fetch_one(db.pool())
    .await?;
    Ok(row.0.unwrap_or(0).max(0) as u64)
}

/// Find a media file (i.e. metadata.role != "metadata") whose stored
/// metadata JSON has the matching `pipelineId`. Backs the on-demand
/// "load media for this pipeline" path: the catalog row caller first
/// looks here to skip the chat walk when the media row is already in
/// SQLite. Returns the newest matching row if more than one exists
/// (deletes happen, re-uploads happen — newest is the one the user
/// probably means).
pub async fn find_media_by_pipeline_id(
    db: &Db,
    pipeline_id: &str,
) -> Result<Option<FileRow>, StorageError> {
    // Pre-filter with LIKE on the JSON-encoded substring so the full
    // table scan stays on the SQLite side; the trailing JSON validation
    // in code guards against substring false positives (e.g. an
    // unrelated row whose metadata happens to contain the same text
    // inside another field).
    let pattern = format!(r#"%"pipelineId":"{pipeline_id}"%"#);
    let rows = sqlx::query_as::<_, FileRow>(
        "SELECT id, name, size_bytes, mime_type, tg_message_id, created_at, \
                text, checksum_sha256, metadata \
         FROM tg_files WHERE metadata LIKE ?1 ORDER BY created_at DESC",
    )
    .bind(&pattern)
    .fetch_all(db.pool())
    .await?;
    for row in rows {
        let Ok(Some(value)) = row.metadata_value() else {
            continue;
        };
        let pid_match = value
            .get("pipelineId")
            .and_then(|v| v.as_str())
            .is_some_and(|p| p == pipeline_id);
        if !pid_match {
            continue;
        }
        let role = value.get("role").and_then(|v| v.as_str());
        if role == Some("metadata") {
            continue;
        }
        return Ok(Some(row));
    }
    Ok(None)
}

/// True when any `tg_file_part` row references this Telegram message
/// id. Used by [`crate::client::ConnectedClient::reconcile_chat_index`]
/// to skip messages already adopted as a part of an existing file
/// (preventing a multipart upload from being re-imported as N separate
/// single-file rows on the next chat walk).
pub async fn part_message_id_exists(db: &Db, tg_message_id: i64) -> Result<bool, StorageError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM tg_file_part WHERE tg_message_id = ?1 LIMIT 1")
            .bind(tg_message_id)
            .fetch_optional(db.pool())
            .await?;
    Ok(row.is_some())
}

// ---- Multipart staging (tg_pending_part) --------------------------------
//
// A multipart file only mints into `tg_files` once every chunk is present,
// but a single chat walk isn't guaranteed to observe them all. These helpers
// let observed chunks accumulate across walks until the group is complete.

/// One staged multipart chunk observed on the chat but not yet minted.
/// The group-level fields (`total` / `name` / … ) are mirrored onto every
/// row so a chunk that lands before chunk 0 still carries them; the upsert
/// keeps the freshest non-null copy.
#[derive(Debug, Clone, FromRow)]
pub struct PendingChunk {
    pub group_id: String,
    pub ord: i64,
    pub tg_message_id: i64,
    pub size_bytes: i64,
    pub part_checksum: Option<String>,
    pub total: i64,
    pub name: String,
    pub declared_size: i64,
    pub mime: String,
    pub caption: Option<String>,
    pub checksum: Option<String>,
    pub metadata: Option<String>,
}

/// Upsert a single observed chunk into the staging table, keyed by
/// `(group_id, ord)`. Re-observing the same chunk refreshes its message id
/// and fills in any group-level field (`checksum` / `metadata` / `caption`)
/// a later chunk supplies that an earlier one lacked.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_pending_part(
    db: &Db,
    group_id: &str,
    ord: i64,
    tg_message_id: i64,
    size_bytes: i64,
    part_checksum: Option<&str>,
    total: i64,
    name: &str,
    declared_size: i64,
    mime: &str,
    caption: Option<&str>,
    checksum: Option<&str>,
    metadata: Option<&str>,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO tg_pending_part \
             (group_id, ord, tg_message_id, size_bytes, part_checksum, total, \
              name, declared_size, mime, caption, checksum, metadata, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(group_id, ord) DO UPDATE SET \
             tg_message_id = excluded.tg_message_id, \
             size_bytes = excluded.size_bytes, \
             part_checksum = COALESCE(excluded.part_checksum, tg_pending_part.part_checksum), \
             total = excluded.total, \
             name = excluded.name, \
             declared_size = excluded.declared_size, \
             mime = excluded.mime, \
             caption = COALESCE(excluded.caption, tg_pending_part.caption), \
             checksum = COALESCE(excluded.checksum, tg_pending_part.checksum), \
             metadata = COALESCE(excluded.metadata, tg_pending_part.metadata)",
    )
    .bind(group_id)
    .bind(ord)
    .bind(tg_message_id)
    .bind(size_bytes)
    .bind(part_checksum)
    .bind(total)
    .bind(name)
    .bind(declared_size)
    .bind(mime)
    .bind(caption)
    .bind(checksum)
    .bind(metadata)
    .bind(Utc::now())
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Every staged chunk across all groups, ordered by `(group_id, ord)` so a
/// caller can fold them back into per-group aggregates. Used to seed a walk
/// with what earlier walks already observed.
pub async fn load_pending_chunks(db: &Db) -> Result<Vec<PendingChunk>, StorageError> {
    let rows = sqlx::query_as::<_, PendingChunk>(
        "SELECT group_id, ord, tg_message_id, size_bytes, part_checksum, total, \
                name, declared_size, mime, caption, checksum, metadata \
         FROM tg_pending_part ORDER BY group_id, ord",
    )
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

/// Drop every staged chunk for a group — called once the group has been
/// minted (or found already minted) so the staging table only ever holds
/// still-incomplete files.
pub async fn delete_pending_group(db: &Db, group_id: &str) -> Result<(), StorageError> {
    sqlx::query("DELETE FROM tg_pending_part WHERE group_id = ?1")
        .bind(group_id)
        .execute(db.pool())
        .await?;
    Ok(())
}

/// Drop every staged chunk for a logical file identified by its stable
/// `(name, declared_size, total)` — called once the file is minted. Unlike
/// [`delete_pending_group`] (keyed on the marker's ephemeral `groupId`), this
/// also clears fragments an interrupted-then-resumed upload left under
/// *different* `groupId`s, so a healed file leaves no staging cruft behind.
pub async fn delete_pending_group_by_identity(
    db: &Db,
    name: &str,
    declared_size: i64,
    total: i64,
) -> Result<(), StorageError> {
    sqlx::query(
        "DELETE FROM tg_pending_part \
         WHERE name = ?1 AND declared_size = ?2 AND total = ?3",
    )
    .bind(name)
    .bind(declared_size)
    .bind(total)
    .execute(db.pool())
    .await?;
    Ok(())
}

/// True when a healthy, fully-minted file already exists for a multipart
/// group: a `tg_files` row whose head (`tg_message_id`) is the group's
/// chunk-0 message and which has exactly `total` parts. A row with fewer
/// parts (an interrupted / poisoned mint) returns `false`, so the caller
/// re-mints it fresh.
pub async fn complete_file_exists(
    db: &Db,
    head_message_id: i64,
    total: i64,
) -> Result<bool, StorageError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM tg_files f \
         WHERE f.tg_message_id = ?1 \
           AND (SELECT COUNT(*) FROM tg_file_part p WHERE p.tg_file_id = f.id) = ?2 \
         LIMIT 1",
    )
    .bind(head_message_id)
    .bind(total)
    .fetch_optional(db.pool())
    .await?;
    Ok(row.is_some())
}

/// Delete any `tg_file_part` rows referencing these Telegram message ids.
/// Each Telegram message holds exactly one chunk of one file, so this only
/// ever removes the group's own (stale / mis-attached) rows — clearing the
/// poison that would otherwise make [`part_message_id_exists`] skip a chunk
/// on every future walk.
pub async fn delete_parts_for_messages(
    db: &Db,
    message_ids: &[i64],
) -> Result<(), StorageError> {
    for &id in message_ids {
        sqlx::query("DELETE FROM tg_file_part WHERE tg_message_id = ?1")
            .bind(id)
            .execute(db.pool())
            .await?;
    }
    Ok(())
}

/// A complete, contiguous multipart group ready to be (re)minted, handed to
/// [`heal_and_mint_multipart`]. `chunks` are `(ord, tg_message_id,
/// size_bytes, part_checksum)` for `ord` `0..total`.
pub struct MintGroup<'a> {
    pub name: &'a str,
    pub final_size: i64,
    pub mime: &'a str,
    pub caption: Option<&'a str>,
    pub checksum: Option<&'a str>,
    pub metadata: Option<&'a str>,
    pub chunks: &'a [(i64, i64, i64, Option<String>)],
}

/// (Re)mint a complete multipart group into `tg_files` + `tg_file_part`,
/// healing any partial / stale prior attempt first.
///
/// Returns `Ok(None)` when a healthy complete file for this group already
/// exists (nothing to do — its stable id is preserved). Otherwise it purges
/// any poison — a broken head row at the group's chunk-0 message and any
/// `tg_file_part` rows for the group's chunk messages (which may be orphaned
/// or mis-attached from an interrupted mint) — then inserts a fresh row and
/// returns `Ok(Some(new_id))`.
pub async fn heal_and_mint_multipart(
    db: &Db,
    group: &MintGroup<'_>,
) -> Result<Option<String>, StorageError> {
    let total = group.chunks.len() as i64;
    let head_message_id = group.chunks.first().map(|c| c.1).unwrap_or(0);

    if complete_file_exists(db, head_message_id, total).await? {
        return Ok(None);
    }

    // Purge any partial / poisoned traces before re-minting. Delete the
    // group's chunk part rows first (covers rows mis-attached to another
    // head), then any head row at the chunk-0 message (FK-cascades its own
    // remaining parts).
    let msg_ids: Vec<i64> = group.chunks.iter().map(|c| c.1).collect();
    delete_parts_for_messages(db, &msg_ids).await?;
    sqlx::query("DELETE FROM tg_files WHERE tg_message_id = ?1")
        .bind(head_message_id)
        .execute(db.pool())
        .await?;

    let id = uuid::Uuid::new_v4().to_string();
    insert(
        db,
        &id,
        group.name,
        group.final_size,
        group.mime,
        head_message_id,
        group.caption,
        group.checksum,
        group.metadata,
    )
    .await?;
    for (ord, msg_id, size, part_checksum) in group.chunks {
        insert_part(db, &id, *ord, *msg_id, *size, part_checksum.as_deref()).await?;
    }
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh() -> Db {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let db = Db::new(pool);
        migrate(&db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn migrate_is_idempotent() {
        let db = fresh().await;
        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();
    }

    #[tokio::test]
    async fn insert_then_get_roundtrips() {
        let db = fresh().await;
        insert(
            &db,
            "id1",
            "movie.mkv",
            1024,
            "video/x-matroska",
            42,
            Some("caption"),
            Some("abcd"),
            Some(r#"{"firkin":"x"}"#),
        )
        .await
        .unwrap();
        let row = get(&db, "id1").await.unwrap().expect("present");
        assert_eq!(row.id, "id1");
        assert_eq!(row.name, "movie.mkv");
        assert_eq!(row.size_bytes, 1024);
        assert_eq!(row.tg_message_id, 42);
        assert_eq!(row.text.as_deref(), Some("caption"));
        assert_eq!(row.checksum_sha256.as_deref(), Some("abcd"));
        let meta = row.metadata_value().unwrap().expect("metadata");
        assert_eq!(meta["firkin"], "x");
    }

    #[tokio::test]
    async fn metadata_value_handles_null_and_empty_and_invalid() {
        // Empty string yields None.
        let row = FileRow {
            id: "x".into(),
            name: "n".into(),
            size_bytes: 0,
            mime_type: "video/mp4".into(),
            tg_message_id: 1,
            created_at: Utc::now(),
            text: None,
            checksum_sha256: None,
            metadata: Some("".into()),
        };
        assert!(row.metadata_value().unwrap().is_none());

        let mut row2 = row.clone();
        row2.metadata = None;
        assert!(row2.metadata_value().unwrap().is_none());

        let mut row3 = row.clone();
        row3.metadata = Some("not-json".into());
        assert!(row3.metadata_value().is_err());
    }

    #[tokio::test]
    async fn list_returns_rows_in_created_at_desc() {
        let db = fresh().await;
        insert(&db, "a", "a.mp3", 1, "audio/mpeg", 1, None, None, None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        insert(&db, "b", "b.mp3", 1, "audio/mpeg", 2, None, None, None)
            .await
            .unwrap();
        let rows = list(&db).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b");
        assert_eq!(rows[1].id, "a");
    }

    #[tokio::test]
    async fn find_by_name_and_checksum_and_message_id() {
        let db = fresh().await;
        insert(
            &db,
            "id1",
            "song.mp3",
            10,
            "audio/mpeg",
            5,
            None,
            Some("hex"),
            None,
        )
        .await
        .unwrap();
        let by_name = find_by_name(&db, "song.mp3").await.unwrap().unwrap();
        assert_eq!(by_name.id, "id1");
        assert!(find_by_name(&db, "missing.mp3").await.unwrap().is_none());
        let by_checksum = find_by_checksum(&db, "hex").await.unwrap().unwrap();
        assert_eq!(by_checksum.id, "id1");
        assert!(find_by_checksum(&db, "nope").await.unwrap().is_none());
        let by_msg = find_by_tg_message_id(&db, 5).await.unwrap().unwrap();
        assert_eq!(by_msg.id, "id1");
        assert!(find_by_tg_message_id(&db, 999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn insert_part_and_list_parts_and_message_id_exists() {
        let db = fresh().await;
        insert(&db, "id1", "f.mp4", 100, "video/mp4", 10, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "id1", 0, 10, 50, Some("p0"))
            .await
            .unwrap();
        insert_part(&db, "id1", 1, 11, 50, Some("p1"))
            .await
            .unwrap();
        let parts = list_parts(&db, "id1").await.unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].ord, 0);
        assert_eq!(parts[1].ord, 1);
        assert_eq!(parts[0].checksum_sha256.as_deref(), Some("p0"));
        assert!(part_message_id_exists(&db, 10).await.unwrap());
        assert!(part_message_id_exists(&db, 11).await.unwrap());
        assert!(!part_message_id_exists(&db, 999).await.unwrap());
    }

    #[tokio::test]
    async fn list_parts_total_size_sums_uploaded_part_bytes() {
        // No head row → no parts → 0.
        let db = fresh().await;
        assert_eq!(list_parts_total_size(&db, "missing").await.unwrap(), 0);

        // Head row with no parts yet (mid-chunk-0) → 0.
        insert(&db, "id1", "f.mp4", 250, "video/mp4", 10, None, None, None)
            .await
            .unwrap();
        assert_eq!(list_parts_total_size(&db, "id1").await.unwrap(), 0);

        // One part lands → first chunk's bytes are now serveable.
        insert_part(&db, "id1", 0, 10, 50, Some("p0"))
            .await
            .unwrap();
        assert_eq!(list_parts_total_size(&db, "id1").await.unwrap(), 50);

        // Second chunk lands → tail moves forward.
        insert_part(&db, "id1", 1, 11, 100, Some("p1"))
            .await
            .unwrap();
        assert_eq!(list_parts_total_size(&db, "id1").await.unwrap(), 150);
    }

    #[tokio::test]
    async fn insert_part_upserts_on_ord_conflict() {
        let db = fresh().await;
        insert(&db, "id1", "f.mp4", 100, "video/mp4", 10, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "id1", 0, 10, 50, Some("old"))
            .await
            .unwrap();
        // Re-pushing the same ord (a resumed chunk whose bytes changed)
        // overwrites the row instead of tripping the PK.
        insert_part(&db, "id1", 0, 99, 60, Some("new"))
            .await
            .unwrap();
        let parts = list_parts(&db, "id1").await.unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].tg_message_id, 99);
        assert_eq!(parts[0].size_bytes, 60);
        assert_eq!(parts[0].checksum_sha256.as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn find_resumable_matches_incomplete_only() {
        let db = fresh().await;
        // A completed upload (checksum set) is NOT a resume target.
        insert(
            &db,
            "done",
            "movie.mp4",
            1000,
            "video/mp4",
            1,
            None,
            Some("fullhash"),
            None,
        )
        .await
        .unwrap();
        assert!(find_resumable(&db, "movie.mp4", 1000)
            .await
            .unwrap()
            .is_none());

        // An interrupted upload (checksum NULL) of the same name + size IS.
        insert(&db, "partial", "movie.mp4", 1000, "video/mp4", 2, None, None, None)
            .await
            .unwrap();
        let found = find_resumable(&db, "movie.mp4", 1000)
            .await
            .unwrap()
            .expect("incomplete row is resumable");
        assert_eq!(found.id, "partial");

        // A different size is not a match.
        assert!(find_resumable(&db, "movie.mp4", 999)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn find_resumable_prefers_most_chunks_landed() {
        let db = fresh().await;
        insert(&db, "few", "ep.mp4", 500, "video/mp4", 1, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "few", 0, 1, 50, Some("a")).await.unwrap();

        insert(&db, "many", "ep.mp4", 500, "video/mp4", 2, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "many", 0, 2, 50, Some("b")).await.unwrap();
        insert_part(&db, "many", 1, 3, 50, Some("c")).await.unwrap();

        let found = find_resumable(&db, "ep.mp4", 500)
            .await
            .unwrap()
            .expect("a resumable row");
        assert_eq!(found.id, "many", "should pick the row with more parts");
    }

    #[tokio::test]
    async fn set_checksum_updates_existing_row() {
        let db = fresh().await;
        insert(&db, "id1", "f.mp4", 1, "video/mp4", 1, None, None, None)
            .await
            .unwrap();
        set_checksum(&db, "id1", "newhex").await.unwrap();
        let row = get(&db, "id1").await.unwrap().unwrap();
        assert_eq!(row.checksum_sha256.as_deref(), Some("newhex"));
    }

    #[tokio::test]
    async fn delete_returns_true_then_false() {
        let db = fresh().await;
        insert(&db, "id1", "f.mp4", 1, "video/mp4", 1, None, None, None)
            .await
            .unwrap();
        assert!(delete(&db, "id1").await.unwrap());
        assert!(!delete(&db, "id1").await.unwrap());
        assert!(get(&db, "id1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn clear_all_drops_files_and_cascades_parts() {
        let db = fresh().await;
        insert(&db, "id1", "f.mp4", 1, "video/mp4", 1, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "id1", 0, 1, 1, None).await.unwrap();
        clear_all(&db).await.unwrap();
        assert!(list(&db).await.unwrap().is_empty());
        let parts = list_parts(&db, "id1").await.unwrap();
        assert!(parts.is_empty());
    }

    #[tokio::test]
    async fn ensure_column_no_ops_when_column_exists() {
        // ensure_column is private but driven by migrate(); rerunning
        // migrate() on a fully-migrated DB exercises every "column
        // already exists" branch without hitting ALTER TABLE.
        let db = fresh().await;
        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();
    }

    #[tokio::test]
    async fn backfill_parts_mints_part_for_pre_parts_rows() {
        // Insert a head row, then manually wipe its tg_file_part rows to
        // simulate the pre-parts world. Running migrate again should
        // re-mint the single part row via backfill_parts.
        let db = fresh().await;
        insert(
            &db,
            "id-legacy",
            "old.mp3",
            5,
            "audio/mpeg",
            7,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM tg_file_part WHERE tg_file_id = ?1")
            .bind("id-legacy")
            .execute(db.pool())
            .await
            .unwrap();
        assert!(list_parts(&db, "id-legacy").await.unwrap().is_empty());

        migrate(&db).await.unwrap();
        let parts = list_parts(&db, "id-legacy").await.unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].ord, 0);
        assert_eq!(parts[0].tg_message_id, 7);
        assert_eq!(parts[0].size_bytes, 5);
    }

    // ---- Multipart staging + heal-mint ----------------------------------

    async fn stage(db: &Db, group: &str, ord: i64, msg: i64, total: i64) {
        upsert_pending_part(
            db, group, ord, msg, 100, None, total, "Movie.mp4", 300, "video/mp4", None, None,
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn pending_parts_accumulate_across_walks_then_clear() {
        let db = fresh().await;
        // Walk 1 sees ords 0 and 2 of a 3-chunk group.
        stage(&db, "g1", 0, 46, 3).await;
        stage(&db, "g1", 2, 159, 3).await;
        let seen = load_pending_chunks(&db).await.unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].total, 3);
        assert_eq!(seen[0].name, "Movie.mp4");

        // Walk 2 fills in the straddling middle chunk (re-observing 0 is a
        // no-op upsert).
        stage(&db, "g1", 0, 46, 3).await;
        stage(&db, "g1", 1, 100, 3).await;
        let seen = load_pending_chunks(&db).await.unwrap();
        assert_eq!(seen.len(), 3, "chunks accumulate across walks");
        assert_eq!(
            seen.iter().map(|c| c.ord).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        delete_pending_group(&db, "g1").await.unwrap();
        assert!(load_pending_chunks(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_by_identity_clears_fragments_under_different_group_ids() {
        let db = fresh().await;
        // An interrupted-then-resumed upload strands one logical file across
        // three marker groupIds (chunk 0 / 1 / 2 of a 3-chunk file) — the
        // real Mulan shape. All share (name, declared_size, total).
        stage(&db, "attempt-a", 0, 46, 3).await;
        stage(&db, "attempt-b", 1, 100, 3).await;
        stage(&db, "attempt-c", 2, 159, 3).await;
        assert_eq!(load_pending_chunks(&db).await.unwrap().len(), 3);

        // Deleting by group_id would only clear one fragment; by identity it
        // clears them all, so a healed file leaves no staging cruft.
        delete_pending_group(&db, "attempt-a").await.unwrap();
        assert_eq!(load_pending_chunks(&db).await.unwrap().len(), 2);

        delete_pending_group_by_identity(&db, "Movie.mp4", 300, 3)
            .await
            .unwrap();
        assert!(load_pending_chunks(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn heal_and_mint_fresh_group() {
        let db = fresh().await;
        let chunks = vec![
            (0i64, 46i64, 100i64, None),
            (1, 100, 100, None),
            (2, 159, 100, None),
        ];
        let group = MintGroup {
            name: "Movie.mp4",
            final_size: 300,
            mime: "video/mp4",
            caption: None,
            checksum: Some("full"),
            metadata: None,
            chunks: &chunks,
        };
        let id = heal_and_mint_multipart(&db, &group)
            .await
            .unwrap()
            .expect("minted");
        let row = get(&db, &id).await.unwrap().expect("head row");
        assert_eq!(row.tg_message_id, 46);
        assert_eq!(list_parts(&db, &id).await.unwrap().len(), 3);

        // Idempotent: a healthy complete file is left untouched (no re-mint).
        assert!(heal_and_mint_multipart(&db, &group).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn heal_purges_poisoned_partial_before_reminting() {
        let db = fresh().await;
        // Simulate a poisoned prior mint: a head row at chunk-0's message
        // (msg 46) but with only 2 of the eventual 3 parts — the exact shape
        // that makes part_message_id_exists skip those chunks forever and
        // strands the file on a second device.
        insert(&db, "broken", "Movie.mp4", 200, "video/mp4", 46, None, None, None)
            .await
            .unwrap();
        insert_part(&db, "broken", 0, 46, 100, None).await.unwrap();
        insert_part(&db, "broken", 1, 100, 100, None).await.unwrap();
        assert!(part_message_id_exists(&db, 100).await.unwrap());

        let chunks = vec![
            (0i64, 46i64, 100i64, None),
            (1, 100, 100, None),
            (2, 159, 100, None),
        ];
        let group = MintGroup {
            name: "Movie.mp4",
            final_size: 300,
            mime: "video/mp4",
            caption: None,
            checksum: None,
            metadata: None,
            chunks: &chunks,
        };
        let id = heal_and_mint_multipart(&db, &group)
            .await
            .unwrap()
            .expect("re-minted after healing");
        assert_ne!(id, "broken");
        // The poisoned row is gone; exactly one complete file remains.
        assert!(get(&db, "broken").await.unwrap().is_none());
        assert!(complete_file_exists(&db, 46, 3).await.unwrap());
        let all = list(&db).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(list_parts(&db, &id).await.unwrap().len(), 3);
    }
}
