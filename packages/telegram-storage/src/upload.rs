//! Reliable chunked upload of a logical file into the destination chat.
//!
//! ## Why a custom MTProto loop
//!
//! `grammers-client::Client::upload_stream` runs four parallel workers
//! that each drain a shared part stream and abort the whole call if any
//! one of them returns an error. That makes large uploads brittle: a
//! single TCP wobble in the middle of a multi-GiB push kills every
//! worker, the user loses their progress, and there's no way to resume
//! short of restarting from byte 0.
//!
//! This module replaces that path with its own loop that drives
//! `upload.saveBigFilePart` directly (or `upload.saveFilePart` for chunks
//! of 10 MB or less, per Telegram's docs; see [`PartMode`]):
//!
//! - **Per-part retry.** Each part call is retried up to
//!   [`MAX_PART_RETRIES`] times on transient errors (connection drops,
//!   floods, 5xx, `*_TIMEOUT`; see [`is_transient`]). `FloodWait` honours
//!   the server-supplied retry delay. Permanent errors (4xx such as
//!   `FILE_PART_*_INVALID`) abort the upload immediately.
//! - **Concurrent parts.** Up to [`PART_CONCURRENCY`] 512 KiB pieces are
//!   in flight at once within a chunk, each dispatched over one of the
//!   dedicated upload connections ([`crate::client::UPLOAD_CONNECTIONS`])
//!   round-robin, so a single MTProto connection's request-at-a-time
//!   latency stops bounding throughput.
//! - **Streaming reads.** The fresh-upload path reads the chunk from the
//!   source in 512 KiB pieces on demand and dispatches each as it's read,
//!   so resident memory stays at ~`PART_CONCURRENCY * MT_PART_SIZE`
//!   instead of a whole 50 MiB chunk. On resume, a chunk that's already on
//!   Telegram (right `ord`, right size) is skipped by *seeking* past it in
//!   the source — no read, no re-hash — so a resume only pays for the
//!   chunks that still have to go over the wire. (The trade-off: a
//!   seek-resumed file gets no full-file checksum, same as a reconciled
//!   row.)
//! - **Per-part progress.** The progress callback is invoked after every
//!   acknowledged 512 KiB piece — so a 50 MiB chunk advances the byte
//!   counter ~100 times instead of jumping 0 → 50 MiB.
//! - **Per-part pause check.** The pause flag is consulted between
//!   pieces and again before each retry — pause is sub-second responsive
//!   without sacrificing already-uploaded bytes.
//! - **Cooperative cancellation.** [`UploadAbortControl::abort`] returns
//!   [`StorageError::UploadAborted`] before the next MTProto call so
//!   callers can tear an upload down hard (e.g. on user "cancel").
//!
//! ## Chunking
//!
//! Logical files larger than [`MAX_CHUNK_BYTES`] (50 MiB) are split
//! across multiple Telegram messages. Each chunk is its own Telegram
//! document upload (its own `file_id`, its own `messages.sendMedia`)
//! and carries a `tgb-multipart` JSON marker as its caption so a fresh
//! device walking the chat can reassemble the file. Files at or under
//! 50 MiB still take the chunked path with `total_chunks = 1` — the
//! single-chunk fast path is gone so every upload writes a consistent
//! schema (head row + N part rows + per-chunk checksums).
//!
//! ## Checksums
//!
//! - The full-file SHA-256 streams alongside the byte flow and lands in
//!   `tg_files.checksum_sha256` once the last chunk's `sendMedia`
//!   succeeds.
//! - Each chunk's SHA-256 lands in its `tg_file_part.checksum_sha256`
//!   row as the chunk completes. The same digest rides inside the
//!   chunk's `tgb-multipart` marker (`partChecksum`) so cross-device
//!   reconcile can verify each chunk without redownloading the whole
//!   file.
//!
//! ## Caller-supplied metadata
//!
//! `UploadRequest::metadata` is an arbitrary `serde_json::Value` —
//! the storage crate doesn't interpret it. It's serialised verbatim
//! into `tg_files.metadata` and into the chunk markers
//! (`metadata` field) so cross-device reconcile mirrors it back into
//! the local SQLite. Callers use this for whatever their domain needs
//! (firkin ids, source URLs, custom tags); nothing in this crate looks
//! at the shape.

use std::collections::HashMap;
use std::future::Future;
use std::io::SeekFrom;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use grammers_client::message::InputMessage;
use grammers_client::Client;
use grammers_tl_types as tl;
use rand::random;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, ReadBuf};
use tokio::time::Sleep;
use uuid::Uuid;

use crate::client::ConnectedClient;
use crate::db as index_db;
use crate::error::StorageError;
use crate::pool::Db;

/// Outer ceiling on the **total** size of a single logical upload.
/// Multipart chunking handles any size up to this limit. Set deliberately
/// large (200 GiB) so the rare large-file cases (4K remuxes, multi-disc
/// rips, large game ISOs) succeed without forcing the user to split
/// manually; the practical limit is the user's bandwidth and Telegram
/// chat storage, not this constant.
pub const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024 * 1024;

/// Per-chunk upload size in bytes (50 MiB). Files larger than this are
/// split into N consecutive Telegram document messages; smaller files
/// land as a single chunk through the same code path. 50 MiB is a
/// deliberate middle ground:
///
/// - small enough to retry a torn chunk without losing meaningful work
///   (a single chunk takes < 1 minute on a 10 Mbit/s link);
/// - large enough that the per-chunk Telegram overhead
///   (`messages.sendMedia` + caption + DB writes) doesn't dominate;
/// - aligned to common LAN MTU multiples (50 MiB is exactly
///   100 × MT_PART_SIZE).
pub const MAX_CHUNK_BYTES: u64 = 50 * 1024 * 1024;

/// MTProto `upload.saveBigFilePart` stride. Telegram requires each part
/// to be ≤ 524288 bytes (512 KiB) and the total number of parts per
/// `file_id` to be ≤ 4000. 50 MiB / 512 KiB = 100 parts per chunk,
/// comfortably within both limits.
const MT_PART_SIZE: usize = 512 * 1024;

/// Largest chunk uploaded through the small-file path
/// (`upload.saveFilePart` + `inputFile`). Telegram's docs put the cut-off
/// at 10 MB: "Use upload.saveBigFilePart in case the full size of the file
/// is more than 10 MB and upload.saveFilePart for smaller files." Full
/// 50 MiB video chunks are always above this, so in practice only a short
/// tail chunk or a small logical file goes through the small path.
const SMALL_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// How many times each `saveBigFilePart` call is retried before giving
/// up on the upload. Transient errors (`InvocationError::Io`,
/// `InvocationError::Dropped`, RPC `*_TIMEOUT`) all count against this
/// budget; permanent RPC errors (`FILE_PART_*_INVALID`, etc.) abort
/// immediately without counting retries.
const MAX_PART_RETRIES: u32 = 5;

/// Multiplier on the exponential backoff between retries. The Nth retry
/// (1-indexed) waits `BACKOFF_BASE_MS * 2^(N-1)` milliseconds, capped at
/// `BACKOFF_CAP_MS`. `FloodWait` overrides this with the server hint.
const BACKOFF_BASE_MS: u64 = 250;
const BACKOFF_CAP_MS: u64 = 15_000;

/// Wire-format version of the `tgb-multipart` caption marker. v1 was
/// the original (caption-only) format; v2 adds `checksum`, `partChecksum`
/// and `metadata` and is what the new upload path always emits. The
/// reconcile parser in `client.rs` accepts both.
const MARKER_VERSION: u32 = 2;

/// Maximum number of 512 KiB `saveBigFilePart` calls kept in flight at
/// once within a single chunk. The previous upload path pushed a chunk's
/// parts strictly one-after-another (one request on the wire per chunk),
/// so throughput was latency-bound; streaming several parts concurrently
/// — spread across the dedicated upload connections
/// ([`crate::client::UPLOAD_CONNECTIONS`]) — keeps the pipe full. Bounded
/// so a torn upload retries only a little work and resident memory stays
/// at roughly `PART_CONCURRENCY * MT_PART_SIZE`.
const PART_CONCURRENCY: usize = 8;

/// Callback fired with the **monotonic** running total of bytes pushed
/// to Telegram so far. Runs from the upload task; cheap and non-blocking
/// only. Used to surface progress to UI poll loops that don't own the
/// underlying stream.
pub type UploadProgressCallback = Arc<dyn Fn(UploadProgress) + Send + Sync>;

/// Callback fired once per logical chunk after its `sendMedia` and DB
/// inserts succeed. Cheap and non-blocking only — runs from the upload
/// task. Used to broadcast per-chunk milestones to outside observers
/// (e.g. the append-only event queue) without coupling the storage
/// crate to the consumer.
pub type ChunkCompletionCallback = Arc<dyn Fn(ChunkCompletion) + Send + Sync>;

/// Snapshot of upload progress passed to [`UploadProgressCallback`]. The
/// raw `bytes_uploaded` counter is monotonic across pause/resume and
/// across chunks — exactly what a UI progress bar needs.
#[derive(Debug, Clone, Copy)]
pub struct UploadProgress {
    /// Total bytes streamed to Telegram and acknowledged, across all
    /// chunks of this logical upload. Monotonic; never resets.
    pub bytes_uploaded: u64,
    /// Total size declared by the caller. `bytes_uploaded / total_bytes`
    /// is the safe ratio for a percentage bar.
    pub total_bytes: u64,
    /// 0-based index of the chunk this progress event belongs to.
    pub chunk_index: u64,
    /// Number of chunks this logical file is split into.
    pub total_chunks: u64,
    /// Bytes uploaded so far within the chunk identified by
    /// `chunk_index`. With parallel chunk uploads the file-wide
    /// `bytes_uploaded` can't be split back into per-chunk progress by
    /// arithmetic (chunks advance simultaneously); consumers wanting a
    /// per-chunk bar should read this directly.
    pub chunk_bytes_uploaded: u64,
}

/// Snapshot delivered to [`ChunkCompletionCallback`] after one logical
/// chunk's Telegram message + DB rows land. Fires exactly once per
/// chunk; with parallel chunk uploads it may fire out of `chunk_index`
/// order (e.g. chunk 2 may complete before chunk 1).
#[derive(Debug, Clone, Copy)]
pub struct ChunkCompletion {
    /// 0-based index of the chunk that just finished.
    pub chunk_index: u64,
    /// Number of chunks this logical file is split into.
    pub total_chunks: u64,
    /// Byte count of this chunk specifically (≤ [`MAX_CHUNK_BYTES`]).
    pub chunk_size_bytes: u64,
    /// Monotonic running total across the whole logical upload after
    /// this chunk's bytes were acked.
    pub bytes_uploaded: u64,
    /// Total size declared by the caller.
    pub total_bytes: u64,
    /// Number of chunks that have completed so far, including this one.
    /// Monotonic — increments by exactly one per callback invocation.
    /// Consumers should use this instead of `chunk_index + 1` because
    /// chunks may complete out of order.
    pub completed_count: u64,
    /// True when this chunk was already on Telegram and got seek-skipped
    /// on resume — its bytes never went over the wire. Consumers that
    /// measure upload speed must exclude these from the transferred-byte
    /// total, or the free bytes dumped in at `transfer_started_at` inflate
    /// the rate and deflate the ETA.
    pub skipped: bool,
}

/// Pause/resume gate shared between the upload task and the UI handler
/// that owns the pause button. While `paused` is set the upload task
/// stops issuing MTProto calls and re-checks every 100 ms; the in-flight
/// 512 KiB piece (if any) completes — pause is granular to the part
/// boundary, not the byte. Calling `resume()` lets the next part fly.
///
/// Both pause/resume *and* abort live on a single control because the
/// UI typically exposes both buttons on the same widget; bundling them
/// keeps the API narrow.
#[derive(Default)]
pub struct UploadPauseControl {
    paused: AtomicBool,
}

impl UploadPauseControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

/// Cooperative cancellation flag. Once `abort()` is called the next
/// part boundary returns [`StorageError::UploadAborted`] and the
/// `tg_files` row is left in whatever partial state the last successful
/// chunk produced — callers that want full cleanup should follow up
/// with [`crate::download::delete`].
#[derive(Default)]
pub struct UploadAbortControl {
    aborted: AtomicBool,
}

impl UploadAbortControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}

/// Caller-facing upload request. Bundles every option the upload path
/// understands so adding new knobs is a struct-field addition rather
/// than a function-signature break.
pub struct UploadRequest {
    /// Filename Telegram should record. Also the dedup key in
    /// [`crate::state::TelegramStorage::upload_local_file`].
    pub name: String,
    /// MIME type. Used for the `inputMediaUploadedDocument.mime_type`
    /// field and stored verbatim in `tg_files.mime_type`.
    pub mime_type: String,
    /// Total logical size of the stream in bytes. Must match the actual
    /// byte count of the supplied reader; the upload aborts with
    /// [`StorageError::BadRequest`] if the reader EOFs early.
    pub total_size_bytes: u64,
    /// Optional caller-supplied JSON metadata. Stored verbatim in
    /// `tg_files.metadata` and in every chunk's `tgb-multipart`
    /// marker so a fresh device can recover it from the chat. The
    /// storage crate never interprets the shape.
    pub metadata: Option<serde_json::Value>,
    /// Optional legacy free-text caption mirrored into `tg_files.text`.
    /// New callers should prefer `metadata`; this field exists for the
    /// existing `tgb-firkin` reconciler that scans `tg_files.text`
    /// strings.
    pub text: Option<String>,
    /// Optional progress callback. Invoked after every successful
    /// `SaveBigFilePart` piece (~ every 512 KiB).
    pub progress: Option<UploadProgressCallback>,
    /// Optional per-chunk completion callback. Invoked once per logical
    /// chunk after its `sendMedia` + DB rows succeed. The progress
    /// callback already fires per part — this one fires per chunk, which
    /// is the cadence outside event consumers (the append-only queue,
    /// long-running orchestrators) typically want.
    pub chunk_callback: Option<ChunkCompletionCallback>,
    /// Optional pause control. While set, the upload sleeps at part
    /// boundaries until `resume()` is called.
    pub pause: Option<Arc<UploadPauseControl>>,
    /// Optional abort control. Once tripped the next part boundary
    /// returns [`StorageError::UploadAborted`].
    pub abort: Option<Arc<UploadAbortControl>>,
    /// Optional Telegram message id to reply to. When set, the head
    /// (chunk-0 / master) message is sent as a native reply to this id
    /// so the file lands as a reply quoting that message. Only chunk 0
    /// carries the reply; the remaining parts are plain follow-up messages.
    pub reply_to_message_id: Option<i32>,
}

impl UploadRequest {
    /// Build a request with only the required fields populated. Use
    /// the `with_*` helpers to attach the optional knobs.
    pub fn new(
        name: impl Into<String>,
        mime_type: impl Into<String>,
        total_size_bytes: u64,
    ) -> Self {
        Self {
            name: name.into(),
            mime_type: mime_type.into(),
            total_size_bytes,
            metadata: None,
            text: None,
            progress: None,
            chunk_callback: None,
            pause: None,
            abort: None,
            reply_to_message_id: None,
        }
    }

    pub fn with_reply_to(mut self, reply_to_message_id: i32) -> Self {
        self.reply_to_message_id = Some(reply_to_message_id);
        self
    }

    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn with_progress(mut self, cb: UploadProgressCallback) -> Self {
        self.progress = Some(cb);
        self
    }

    pub fn with_chunk_callback(mut self, cb: ChunkCompletionCallback) -> Self {
        self.chunk_callback = Some(cb);
        self
    }

    pub fn with_pause(mut self, pause: Arc<UploadPauseControl>) -> Self {
        self.pause = Some(pause);
        self
    }

    pub fn with_abort(mut self, abort: Arc<UploadAbortControl>) -> Self {
        self.abort = Some(abort);
        self
    }
}

#[derive(Debug)]
pub struct UploadResult {
    /// `tg_files.id` (uuid).
    pub id: String,
    /// Telegram message id of the **first** chunk. For single-chunk
    /// uploads this is the only message; for multipart uploads the
    /// remaining chunks live in `tg_file_part` rows ordered by `ord`.
    pub tg_message_id: i64,
    /// Hex-encoded SHA-256 of the full logical file. Mirrored into
    /// `tg_files.checksum_sha256` and every chunk's `tgb-multipart`
    /// marker.
    pub sha256_hex: String,
}

/// Drive the chunked upload. The reader is consumed sequentially; the
/// upload task reads exactly `request.total_size_bytes` bytes from it
/// (split across chunks) and aborts if EOF arrives early.
pub async fn upload<S>(
    connected: &ConnectedClient,
    db: &Db,
    request: UploadRequest,
    mut stream: S,
) -> Result<UploadResult, StorageError>
where
    S: AsyncRead + AsyncSeek + Unpin,
{
    if request.total_size_bytes > MAX_UPLOAD_BYTES {
        return Err(StorageError::FileTooLarge {
            limit_bytes: MAX_UPLOAD_BYTES,
        });
    }

    let target = connected.target_peer().await?;
    // Deterministic from the `(name, size)` identity `find_resumable` resumes
    // on, so a fresh upload and every later resume of the same file tag their
    // chunks with the SAME marker `groupId`. A random per-attempt id used to
    // fragment an interrupted-then-resumed file across several `groupId`s,
    // which a second device rebuilding from the chat could never re-fuse — it
    // saw one incomplete group per attempt and never minted the file.
    let group_id = stable_group_id(&request.name, request.total_size_bytes);

    let total_chunks = if request.total_size_bytes == 0 {
        1
    } else {
        request.total_size_bytes.div_ceil(MAX_CHUNK_BYTES).max(1)
    };

    // Resumable upload: an interrupted prior attempt at the same logical
    // file (same name + size, never completed) leaves its already-landed
    // chunks on Telegram + in `tg_file_part`. Reuse that row id and skip
    // re-pushing every chunk whose bytes still match — only the missing /
    // changed chunks go back over the wire. A fresh upload (no match) mints
    // a new id and uploads everything, exactly as before.
    let resumable =
        index_db::find_resumable(db, &request.name, request.total_size_bytes as i64).await?;
    let (id, existing_parts, resuming) = match resumable {
        Some(row) => {
            let parts = index_db::list_parts(db, &row.id).await?;
            let map: HashMap<u64, index_db::FilePart> =
                parts.into_iter().map(|p| (p.ord as u64, p)).collect();
            log::info!(
                target: "tgb-telegram-storage",
                "resuming interrupted upload of {name:?}: {landed}/{total_chunks} chunk(s) already on Telegram (id={id})",
                name = request.name,
                landed = map.len(),
                id = row.id,
            );
            (row.id, map, true)
        }
        None => (Uuid::new_v4().to_string(), HashMap::new(), false),
    };

    log::info!(
        target: "tgb-telegram-storage",
        "uploading {name:?} ({size} bytes, mime={mime}, chunks={total_chunks}) to chat {chat_id:?}",
        name = request.name,
        size = request.total_size_bytes,
        mime = request.mime_type,
        chat_id = target.id,
    );

    let metadata_string: Option<String> = match request.metadata.as_ref() {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
    };
    let metadata_value = request.metadata.clone();

    let mut full_hasher = Sha256::new();
    let bytes_uploaded_total = Arc::new(AtomicU64::new(0));
    let completed_count = Arc::new(AtomicU64::new(0));
    let mut remaining = request.total_size_bytes;
    // On resume the head `tg_files` row already exists, so `persist_chunk`
    // must UPDATE the head message id (when chunk 0 re-lands) rather than
    // re-INSERT the row and trip the primary key.
    let mut head_row_written = resuming;
    let mut chunk_zero_msg_id: Option<i64> = None;
    // Stays true only while every byte of the file flows through
    // `full_hasher` in order. The fast-resume path below seeks *past* a
    // chunk that's already on Telegram instead of reading + re-hashing its
    // 50 MiB, which leaves a hole in the streaming digest — so any skip
    // flips this false and the final full-file checksum is left NULL
    // (exactly the state a cross-device reconcile produces; `verify()` and
    // the catalog both tolerate a NULL checksum). A fresh upload never
    // skips, so its checksum is written exactly as before.
    let mut full_hash_valid = true;

    // Open the dedicated upload connections once up front so the per-part
    // round-robin inside `upload_chunk` is a cheap synchronous pick. A
    // failure to open the extra sockets degrades to the main connection
    // (still correct, just slower).
    connected.ensure_upload_pool().await;

    // Chunks are processed sequentially so the full-file hash streams in
    // order and the DB rows land in order; within each chunk the 512 KiB
    // parts fly concurrently across the upload connections.
    for chunk_index in 0..total_chunks {
        check_abort(request.abort.as_ref())?;
        let chunk_size = remaining.min(MAX_CHUNK_BYTES);

        // Resume fast path: a chunk of the expected size is already on
        // Telegram, so skip it WITHOUT touching the source — seek the
        // cursor forward to the next chunk boundary instead of reading +
        // re-hashing its 50 MiB. The network push was already skipped; the
        // local read + re-hash was the only remaining per-chunk cost, and
        // on a slow disk that read dominated resume time (~seconds/chunk).
        // Because we skip the bytes, the streaming full-file digest can no
        // longer be completed (`full_hash_valid` goes false → NULL
        // checksum). The size check is what makes this safe: `find_resumable`
        // already matched on (name, size), and these upload sources are
        // content-deterministic, so a same-size landed chunk is the same
        // chunk. A stale part row of the WRONG size falls through and is
        // re-read + re-uploaded below.
        if let Some(part) = existing_parts.get(&chunk_index) {
            if part.size_bytes as u64 == chunk_size {
                if chunk_size > 0 {
                    stream.seek(SeekFrom::Current(chunk_size as i64)).await?;
                }
                full_hash_valid = false;
                remaining = remaining.saturating_sub(chunk_size);
                bytes_uploaded_total.fetch_add(chunk_size, Ordering::SeqCst);
                if chunk_index == 0 {
                    chunk_zero_msg_id = Some(part.tg_message_id);
                }
                let done_so_far = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(cb) = request.chunk_callback.as_ref() {
                    cb(ChunkCompletion {
                        chunk_index,
                        total_chunks,
                        chunk_size_bytes: chunk_size,
                        bytes_uploaded: bytes_uploaded_total.load(Ordering::SeqCst),
                        total_bytes: request.total_size_bytes,
                        completed_count: done_so_far,
                        skipped: true,
                    });
                }
                log::info!(
                    target: "tgb-telegram-storage",
                    "skipping chunk {idx}/{total} of {name:?} — already on Telegram (msg_id={msg})",
                    idx = chunk_index + 1,
                    total = total_chunks,
                    name = request.name,
                    msg = part.tg_message_id,
                );
                continue;
            }

            // Stale part row of the wrong size — read the current bytes and
            // re-upload the chunk from that buffer. The full hash is already
            // compromised by any earlier skip, so don't bother folding these
            // bytes in.
            let mut chunk_bytes = vec![0u8; chunk_size as usize];
            let read = read_exact_or_eof(&mut stream, &mut chunk_bytes).await?;
            if read < chunk_size as usize {
                return Err(StorageError::BadRequest(format!(
                    "upload reader ended early: expected {chunk_size} more bytes for chunk {chunk_index}, got {read}"
                )));
            }
            full_hash_valid = false;
            remaining = remaining.saturating_sub(chunk_size);
            log::info!(
                target: "tgb-telegram-storage",
                "re-uploading changed chunk {idx}/{total} of {name:?} ({chunk_size} bytes)",
                idx = chunk_index + 1,
                total = total_chunks,
                name = request.name,
            );
            let outcome = upload_chunk::<S>(
                connected,
                target,
                &group_id,
                &request,
                metadata_value.as_ref(),
                PieceSource::Buffer {
                    data: chunk_bytes,
                    offset: 0,
                },
                None,
                chunk_index,
                chunk_size,
                total_chunks,
                &bytes_uploaded_total,
                request.progress.as_ref(),
                request.pause.as_ref(),
                request.abort.as_ref(),
            )
            .await?;
            persist_chunk(
                db,
                &id,
                &request,
                metadata_string.as_deref(),
                outcome,
                &bytes_uploaded_total,
                &completed_count,
                &mut head_row_written,
                &mut chunk_zero_msg_id,
            )
            .await?;
            continue;
        }

        // Fresh chunk: stream it from the source in 512 KiB pieces.
        log::info!(
            target: "tgb-telegram-storage",
            "uploading chunk {idx}/{total} of {name:?} ({chunk_size} bytes)",
            idx = chunk_index + 1,
            total = total_chunks,
            name = request.name,
        );
        let outcome = upload_chunk(
            connected,
            target,
            &group_id,
            &request,
            metadata_value.as_ref(),
            PieceSource::Stream(&mut stream),
            Some(&mut full_hasher),
            chunk_index,
            chunk_size,
            total_chunks,
            &bytes_uploaded_total,
            request.progress.as_ref(),
            request.pause.as_ref(),
            request.abort.as_ref(),
        )
        .await?;
        remaining = remaining.saturating_sub(chunk_size);
        persist_chunk(
            db,
            &id,
            &request,
            metadata_string.as_deref(),
            outcome,
            &bytes_uploaded_total,
            &completed_count,
            &mut head_row_written,
            &mut chunk_zero_msg_id,
        )
        .await?;
    }

    // Only persist the full-file checksum when every byte actually flowed
    // through the hasher. A resume that seek-skipped already-landed chunks
    // never saw those bytes, so its digest is meaningless — leave the row's
    // `checksum_sha256` NULL (matching a reconciled row; `verify()` and the
    // catalog tolerate it, and `find_resumable` will just fast-resume it
    // again if this file is ever re-uploaded).
    let sha256_hex = if full_hash_valid {
        let hex = hex_encode(&full_hasher.finalize());
        index_db::set_checksum(db, &id, &hex).await?;
        hex
    } else {
        String::new()
    };

    let tg_message_id = chunk_zero_msg_id
        .ok_or_else(|| StorageError::Internal("chunked upload produced zero chunks".to_string()))?;
    log::info!(
        target: "tgb-telegram-storage",
        "upload finished for {name:?} ({total_chunks} chunks, sha256={sha}, first_msg_id={tg_message_id})",
        name = request.name,
        sha = if sha256_hex.is_empty() { "<skipped: seek-resume>" } else { sha256_hex.as_str() },
    );
    Ok(UploadResult {
        id,
        tg_message_id,
        sha256_hex,
    })
}

/// Result a parallel chunk task hands back to the outer driver so it
/// can write the DB rows + fire the chunk callback in completion order.
struct ChunkUploadOutcome {
    chunk_index: u64,
    chunk_size: u64,
    total_chunks: u64,
    msg_id: i64,
    sha256_hex: String,
}

/// Where a chunk's 512 KiB pieces come from. The fresh-upload path reads
/// them straight off the source reader on demand (`Stream`), so a whole
/// chunk never sits in memory; the resume re-upload path replays a chunk
/// already buffered in RAM (`Buffer`) because the outer loop had to read
/// it to compare the per-chunk checksum.
enum PieceSource<'a, S> {
    Stream(&'a mut S),
    Buffer { data: Vec<u8>, offset: usize },
}

impl<S: AsyncRead + Unpin> PieceSource<'_, S> {
    /// Yield the next piece of up to `want` bytes. The `Stream` variant
    /// requires exactly `want` bytes (a short read means the caller
    /// mis-sized the chunk) and errors otherwise; the `Buffer` variant
    /// slices what it has.
    async fn next_piece(&mut self, want: usize) -> Result<Vec<u8>, StorageError> {
        match self {
            PieceSource::Stream(reader) => {
                let mut buf = vec![0u8; want];
                let n = read_exact_or_eof(&mut **reader, &mut buf).await?;
                if n < want {
                    return Err(StorageError::BadRequest(format!(
                        "upload reader ended early: wanted {want} more bytes, got {n}"
                    )));
                }
                Ok(buf)
            }
            PieceSource::Buffer { data, offset } => {
                let end = (*offset + want).min(data.len());
                let piece = data[*offset..end].to_vec();
                *offset = end;
                Ok(piece)
            }
        }
    }
}

/// Upload one chunk: stream its 512 KiB parts through `SaveBigFilePart`
/// (up to [`PART_CONCURRENCY`] in flight at once, each on a round-robin
/// upload connection), then post the assembled `InputFileBig` via
/// `sendMedia`. Returns the chunk's Telegram message id + per-chunk
/// SHA-256 so the driver can persist the row.
///
/// When `full_hasher` is `Some`, every piece is folded into it as it's
/// read (the streaming fresh path, where this is the only pass over the
/// bytes). The resume re-upload path passes `None` because the outer
/// loop already hashed the buffered chunk into the full-file digest.
#[allow(clippy::too_many_arguments)]
async fn upload_chunk<S: AsyncRead + Unpin>(
    connected: &ConnectedClient,
    target: grammers_session::types::PeerRef,
    group_id: &str,
    request: &UploadRequest,
    metadata_value: Option<&serde_json::Value>,
    mut source: PieceSource<'_, S>,
    mut full_hasher: Option<&mut Sha256>,
    chunk_index: u64,
    chunk_size: u64,
    total_chunks: u64,
    bytes_uploaded_total: &Arc<AtomicU64>,
    progress: Option<&UploadProgressCallback>,
    pause: Option<&Arc<UploadPauseControl>>,
    abort: Option<&Arc<UploadAbortControl>>,
) -> Result<ChunkUploadOutcome, StorageError> {
    let total_bytes = request.total_size_bytes;
    let file_id: i64 = loop {
        let candidate: i64 = random();
        // 0 is technically valid but Telegram has historically treated it
        // as "not set" in adjacent contexts, so pick again.
        if candidate != 0 {
            break candidate;
        }
    };

    let parts_count: u64 = if chunk_size == 0 {
        1
    } else {
        chunk_size.div_ceil(MT_PART_SIZE as u64)
    };
    if parts_count > i32::MAX as u64 {
        return Err(StorageError::Internal(format!(
            "chunk part count {parts_count} overflows i32"
        )));
    }
    let parts: i32 = parts_count as i32;

    // Each chunk is its own Telegram file, so the big/small decision is
    // per chunk: full 50 MiB video chunks stay on `saveBigFilePart`, while
    // a short tail chunk (or a small logical file) takes the documented
    // `saveFilePart` + `inputFile` path with an MD5 the server verifies.
    let mode = PartMode::for_chunk_size(chunk_size);
    let mut chunk_md5 = match mode {
        PartMode::Small => Some(md5::Context::new()),
        PartMode::Big => None,
    };

    let mut chunk_hasher = Sha256::new();

    if chunk_size == 0 {
        // Zero-byte logical files still need one (empty) part so
        // `inputFileBig.parts >= 1` and `messages.sendMedia` accepts the
        // upload. Telegram allows a zero-length part for this case.
        check_abort(abort)?;
        wait_while_paused(pause).await;
        let client = connected.upload_client_rr();
        save_file_part_with_retry(&client, mode, file_id, 0, 1, Vec::new(), pause, abort).await?;
    } else {
        let mut chunk_bytes_uploaded: u64 = 0;
        let mut remaining = chunk_size;
        let mut part_idx: i32 = 0;
        let mut in_flight = FuturesUnordered::new();

        loop {
            check_abort(abort)?;

            // Top the pipeline up to PART_CONCURRENCY in-flight parts,
            // reading (and hashing) each piece in order as we dispatch it.
            while remaining > 0 && in_flight.len() < PART_CONCURRENCY {
                wait_while_paused(pause).await;
                let want = remaining.min(MT_PART_SIZE as u64) as usize;
                let piece = source.next_piece(want).await?;
                let piece_len = piece.len() as u64;
                chunk_hasher.update(&piece);
                if let Some(h) = full_hasher.as_deref_mut() {
                    h.update(&piece);
                }
                if let Some(m) = chunk_md5.as_mut() {
                    m.consume(&piece);
                }
                remaining = remaining.saturating_sub(piece_len);
                let this_part = part_idx;
                part_idx += 1;
                let client = connected.upload_client_rr();
                in_flight.push(async move {
                    save_file_part_with_retry(
                        &client, mode, file_id, this_part, parts, piece, pause, abort,
                    )
                    .await?;
                    Ok::<u64, StorageError>(piece_len)
                });
            }

            match in_flight.next().await {
                Some(res) => {
                    let piece_len = res?;
                    chunk_bytes_uploaded += piece_len;
                    let file_bytes_uploaded =
                        bytes_uploaded_total.fetch_add(piece_len, Ordering::SeqCst) + piece_len;
                    if let Some(cb) = progress {
                        cb(UploadProgress {
                            bytes_uploaded: file_bytes_uploaded,
                            total_bytes,
                            chunk_index,
                            total_chunks,
                            chunk_bytes_uploaded,
                        });
                    }
                }
                None => {
                    // Nothing left in flight; if the source is drained too
                    // the chunk is done.
                    if remaining == 0 {
                        break;
                    }
                }
            }
        }
    }

    let sha256_hex = hex_encode(&chunk_hasher.finalize());
    let chunk_name = if total_chunks == 1 {
        request.name.clone()
    } else {
        format!("{}.part{}of{}", request.name, chunk_index + 1, total_chunks)
    };
    let marker = build_multipart_marker(
        group_id,
        chunk_index,
        total_chunks,
        &request.name,
        total_bytes,
        &request.mime_type,
        request.text.as_deref(),
        metadata_value,
        None,
        &sha256_hex,
    );
    let input_file: tl::enums::InputFile = match chunk_md5 {
        Some(md5_ctx) => tl::types::InputFile {
            id: file_id,
            parts,
            name: chunk_name,
            md5_checksum: format!("{:x}", md5_ctx.finalize()),
        }
        .into(),
        None => tl::types::InputFileBig {
            id: file_id,
            parts,
            name: chunk_name,
        }
        .into(),
    };
    let uploaded = grammers_client::media::Uploaded::from_raw(input_file);
    let mut input = InputMessage::new().text(&marker).file(uploaded);
    // Only the head (chunk-0 / master) message quotes the parent; the
    // remaining parts are plain follow-ups so the reply chain stays
    // anchored on the one message `file_message_ids().head_message_id`
    // returns.
    if chunk_index == 0 {
        if let Some(reply_to) = request.reply_to_message_id {
            input = input.reply_to(Some(reply_to));
        }
    }
    let msg = connected.client.send_message(target, input).await?;

    Ok(ChunkUploadOutcome {
        chunk_index,
        chunk_size,
        total_chunks,
        msg_id: msg.id() as i64,
        sha256_hex,
    })
}

/// Persist the DB rows for a chunk that just finished uploading and
/// fire the per-chunk callback. Writes the `tg_files` head row the first
/// time any chunk lands (using that chunk's msg id as a placeholder) so
/// later `tg_file_part` inserts satisfy the FK; updates the head row's
/// `tg_message_id` to chunk-0's id once chunk 0 specifically lands so
/// downstream lookups by head message id stay consistent with the
/// pre-parallel semantic.
#[allow(clippy::too_many_arguments)]
async fn persist_chunk(
    db: &Db,
    id: &str,
    request: &UploadRequest,
    metadata_string: Option<&str>,
    outcome: ChunkUploadOutcome,
    bytes_uploaded_total: &Arc<AtomicU64>,
    completed_count: &Arc<AtomicU64>,
    head_row_written: &mut bool,
    chunk_zero_msg_id: &mut Option<i64>,
) -> Result<(), StorageError> {
    let head_written_now = if !*head_row_written {
        index_db::insert(
            db,
            id,
            &request.name,
            request.total_size_bytes as i64,
            &request.mime_type,
            outcome.msg_id,
            request.text.as_deref(),
            None,
            metadata_string,
        )
        .await?;
        *head_row_written = true;
        true
    } else {
        false
    };

    if outcome.chunk_index == 0 {
        // When chunk 0 isn't the first to complete, the head row was
        // inserted with a different chunk's msg_id as a placeholder so
        // FK constraints on `tg_file_part` were satisfied. Update it
        // now so `tg_files.tg_message_id` keeps its pre-parallel
        // semantic ("the first chunk's Telegram message id").
        if !head_written_now {
            index_db::update_head_message_id(db, id, outcome.msg_id).await?;
        }
        *chunk_zero_msg_id = Some(outcome.msg_id);
    }

    index_db::insert_part(
        db,
        id,
        outcome.chunk_index as i64,
        outcome.msg_id,
        outcome.chunk_size as i64,
        Some(&outcome.sha256_hex),
    )
    .await?;

    let done_so_far = completed_count.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(cb) = request.chunk_callback.as_ref() {
        cb(ChunkCompletion {
            chunk_index: outcome.chunk_index,
            total_chunks: outcome.total_chunks,
            chunk_size_bytes: outcome.chunk_size,
            bytes_uploaded: bytes_uploaded_total.load(Ordering::SeqCst),
            total_bytes: request.total_size_bytes,
            completed_count: done_so_far,
            skipped: false,
        });
    }

    Ok(())
}

/// Call `upload.saveBigFilePart` (or `upload.saveFilePart` for
/// [`PartMode::Small`]) with bounded exponential backoff on transient
/// failures (see [`is_transient`]). `FloodWait` honours the
/// server-supplied delay; everything else uses
/// `BACKOFF_BASE_MS * 2^attempt` capped at `BACKOFF_CAP_MS`. Permanent
/// errors (bad part size/number, auth, …) abort immediately.
#[allow(clippy::too_many_arguments)]
async fn save_file_part_with_retry(
    client: &Client,
    mode: PartMode,
    file_id: i64,
    file_part: i32,
    file_total_parts: i32,
    bytes: Vec<u8>,
    pause: Option<&Arc<UploadPauseControl>>,
    abort: Option<&Arc<UploadAbortControl>>,
) -> Result<(), StorageError> {
    let mut attempt: u32 = 0;
    // The MTProto request consumes the payload and a transient failure
    // needs to resend the identical bytes, so `bytes` is retained and a
    // copy is sent on each attempt — except the final permitted attempt,
    // which can move the retained buffer in with no clone (there's no
    // retry left to preserve it for). The happy path (attempt 0 succeeds)
    // costs exactly one copy.
    let mut retained: Option<Vec<u8>> = Some(bytes);
    loop {
        check_abort(abort)?;
        wait_while_paused(pause).await;

        let payload = if attempt >= MAX_PART_RETRIES {
            retained.take().expect("payload retained until last attempt")
        } else {
            retained
                .as_ref()
                .expect("payload retained until last attempt")
                .clone()
        };
        let res = match mode {
            PartMode::Big => {
                client
                    .invoke(&tl::functions::upload::SaveBigFilePart {
                        file_id,
                        file_part,
                        file_total_parts,
                        bytes: payload,
                    })
                    .await
            }
            PartMode::Small => {
                client
                    .invoke(&tl::functions::upload::SaveFilePart {
                        file_id,
                        file_part,
                        bytes: payload,
                    })
                    .await
            }
        };
        let method = mode.method_name();
        match res {
            Ok(true) => return Ok(()),
            Ok(false) => {
                // Server explicitly rejected the part. Not retriable —
                // a `false` here means "stored data is bad", which our
                // re-sending the same bytes wouldn't fix.
                return Err(StorageError::Telegram(format!(
                    "{method}({file_id}, part={file_part}) returned false"
                )));
            }
            Err(e) => {
                let transient = is_transient(&e);
                let storage_err: StorageError = e.into();
                if !transient || attempt >= MAX_PART_RETRIES {
                    return Err(storage_err);
                }
                let delay_ms = retry_delay_ms(&storage_err, attempt);
                log::warn!(
                    target: "tgb-telegram-storage",
                    "{method}({file_id}, part={file_part}) attempt {} failed: {storage_err}; retrying in {delay_ms} ms",
                    attempt + 1,
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                attempt += 1;
            }
        }
    }
}

/// Deterministic multipart `groupId` for a logical file, derived from the
/// same `(name, total_size)` identity [`index_db::find_resumable`] resumes on.
/// Because it's stable across attempts, a fresh upload and every later resume
/// tag their chunks with one coherent `groupId` — so a second device
/// rebuilding `tg_files` from the chat sees a single group instead of one
/// fragment per interrupted attempt. (Reconstruction now also keys on
/// `(name, size, total)` regardless, so this is belt-and-braces plus it keeps
/// the on-chat markers clean.)
fn stable_group_id(name: &str, total_size: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0u8]);
    hasher.update(total_size.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

/// Whether a failed part upload is worth resending unchanged.
///
/// Classified on the raw grammers error (before it's flattened into a
/// [`StorageError`] string) so request-level 4xx RPC errors —
/// `FILE_PART_TOO_BIG`, `FILE_PARTS_INVALID`, `FILE_PART_SIZE_CHANGED`,
/// auth errors, … — fail fast instead of burning the retry budget.
///
/// Transient: connection-level failures (`Io`, `Transport`, `Dropped`,
/// `Deserialize`), floods (420: `FLOOD_WAIT_X`, `FLOOD_PREMIUM_WAIT_X`),
/// server-side errors (5xx and the `-503` timeout), and the `*_TIMEOUT`
/// family. Everything else is permanent.
fn is_transient(err: &grammers_client::InvocationError) -> bool {
    use grammers_client::InvocationError as E;
    match err {
        E::Io(_) | E::Transport(_) | E::Dropped | E::Deserialize(_) => true,
        E::Rpc(rpc) => {
            rpc.code == 420
                || rpc.code >= 500
                || rpc.code == -503
                || rpc.name.ends_with("_TIMEOUT")
        }
        E::InvalidDc | E::Authentication(_) => false,
    }
}

/// Which MTProto part-upload method a chunk uses. Telegram's docs
/// (core.telegram.org/api/files) prescribe `upload.saveBigFilePart` +
/// `inputFileBig` for files over 10 MB and `upload.saveFilePart` +
/// `inputFile` (with an MD5 the server verifies) for smaller ones. Each
/// chunk is its own Telegram file, so the choice is made per chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartMode {
    Small,
    Big,
}

impl PartMode {
    fn for_chunk_size(chunk_size: u64) -> Self {
        // The zero-byte case keeps its long-standing big-file path (one
        // empty `saveBigFilePart`) rather than risking `FILE_PART_EMPTY`
        // semantics differing on the small-file endpoint.
        if chunk_size == 0 || chunk_size > SMALL_FILE_MAX_BYTES {
            Self::Big
        } else {
            Self::Small
        }
    }

    fn method_name(self) -> &'static str {
        match self {
            Self::Big => "saveBigFilePart",
            Self::Small => "saveFilePart",
        }
    }
}

fn retry_delay_ms(err: &StorageError, attempt: u32) -> u64 {
    if let StorageError::RateLimited {
        retry_after_seconds,
    } = err
    {
        return retry_after_seconds.saturating_mul(1000);
    }
    let exp = BACKOFF_BASE_MS.saturating_mul(1u64 << attempt.min(8));
    exp.min(BACKOFF_CAP_MS)
}

fn check_abort(abort: Option<&Arc<UploadAbortControl>>) -> Result<(), StorageError> {
    match abort {
        Some(a) if a.is_aborted() => Err(StorageError::UploadAborted),
        _ => Ok(()),
    }
}

async fn wait_while_paused(pause: Option<&Arc<UploadPauseControl>>) {
    let Some(p) = pause else { return };
    while p.is_paused() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Read up to `buf.len()` bytes into `buf` from `stream`. Returns the
/// actual byte count; only short of `buf.len()` if the stream ended.
async fn read_exact_or_eof<R: AsyncRead + Unpin>(
    stream: &mut R,
    buf: &mut [u8],
) -> Result<usize, StorageError> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = stream.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// JSON caption stamped on every chunk. v2 adds `checksum`,
/// `partChecksum`, and `metadata`; v1 fields stay so the reconcile
/// parser in `client.rs` can read either generation without branching.
#[allow(clippy::too_many_arguments)]
fn build_multipart_marker(
    group_id: &str,
    index: u64,
    total: u64,
    name: &str,
    size: u64,
    mime: &str,
    caption: Option<&str>,
    metadata: Option<&serde_json::Value>,
    full_checksum: Option<&str>,
    part_checksum: &str,
) -> String {
    let body = serde_json::json!({
        "v": MARKER_VERSION,
        "kind": "tgb-multipart",
        "groupId": group_id,
        "index": index,
        "total": total,
        "name": name,
        "size": size,
        "mime": mime,
        "caption": caption,
        "checksum": full_checksum,
        "partChecksum": part_checksum,
        "metadata": metadata,
    });
    body.to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ----- Module shims: pause-aware AsyncRead wrapper kept for callers
// that need to feed an upload from an external reader they don't fully
// control. The new upload path doesn't use it; it's exposed for places
// that still hand bytes to grammers directly. The implementation is the
// same as the previous in-tree version, minus the byte-counter callback
// (which is now part of `UploadProgressCallback` driven by the chunk
// loop).
struct PauseReader<R> {
    inner: R,
    pause: Arc<UploadPauseControl>,
    sleep_fut: Option<Pin<Box<Sleep>>>,
}

impl<R: AsyncRead + Unpin> AsyncRead for PauseReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.pause.is_paused() {
            let this = self.as_mut().get_mut();
            if this.sleep_fut.is_none() {
                this.sleep_fut = Some(Box::pin(tokio::time::sleep(Duration::from_millis(100))));
            }
            let sleep = this.sleep_fut.as_mut().expect("just set");
            match sleep.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(()) => {
                    this.sleep_fut = None;
                    return Self::poll_read(self, cx, buf);
                }
            }
        } else if self.sleep_fut.is_some() {
            self.as_mut().get_mut().sleep_fut = None;
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

/// Wrap an `AsyncRead` so it returns `Pending` while a paired
/// [`UploadPauseControl`] is in the paused state. Provided for callers
/// that drive their own upload loops; the in-tree chunked upload does
/// pause-awareness at the part boundary directly and doesn't use this.
pub fn paused_reader<R: AsyncRead + Unpin>(
    inner: R,
    pause: Arc<UploadPauseControl>,
) -> impl AsyncRead + Unpin {
    PauseReader {
        inner,
        pause,
        sleep_fut: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_count_under_threshold() {
        let size: u64 = MAX_CHUNK_BYTES - 1;
        let n = if size == 0 {
            1
        } else {
            size.div_ceil(MAX_CHUNK_BYTES)
        };
        assert_eq!(n, 1);
    }

    #[test]
    fn stable_group_id_is_deterministic_per_logical_file() {
        // A resume must reproduce the id a fresh upload of the same file made,
        // so both attempts tag their chunks with one coherent groupId.
        let fresh = stable_group_id("Mulan", 1_392_198_638);
        let resume = stable_group_id("Mulan", 1_392_198_638);
        assert_eq!(fresh, resume);
        // Distinct files (name or size) get distinct ids.
        assert_ne!(fresh, stable_group_id("Mulan", 1_392_198_639));
        assert_ne!(fresh, stable_group_id("Mulan 2", 1_392_198_638));
    }

    #[test]
    fn chunk_count_at_threshold() {
        let size: u64 = MAX_CHUNK_BYTES;
        let n = if size == 0 {
            1
        } else {
            size.div_ceil(MAX_CHUNK_BYTES)
        };
        assert_eq!(n, 1);
    }

    /// 175 MiB → 4 chunks of 50 + 50 + 50 + 25 MiB.
    #[test]
    fn chunk_count_175_mib() {
        let size: u64 = 175 * 1024 * 1024;
        let n = size.div_ceil(MAX_CHUNK_BYTES);
        assert_eq!(n, 4);
    }

    #[test]
    fn marker_v2_round_trip_with_metadata() {
        let meta =
            serde_json::json!({ "firkinId": "tmdb-movie-12345-en", "tags": ["movie", "4k"] });
        let raw = build_multipart_marker(
            "11111111-2222-3333-4444-555555555555",
            2,
            5,
            "Big.Movie.2024.mkv",
            5 * MAX_CHUNK_BYTES,
            "video/x-matroska",
            Some("caption text"),
            Some(&meta),
            Some("abcdef0123456789".repeat(4).as_str()),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(value["v"], 2);
        assert_eq!(value["kind"], "tgb-multipart");
        assert_eq!(value["index"], 2);
        assert_eq!(value["total"], 5);
        assert_eq!(value["name"], "Big.Movie.2024.mkv");
        assert_eq!(value["mime"], "video/x-matroska");
        assert_eq!(value["caption"], "caption text");
        assert_eq!(value["metadata"]["firkinId"], "tmdb-movie-12345-en");
        assert_eq!(value["metadata"]["tags"][1], "4k");
        assert!(value["checksum"].is_string());
        assert!(value["partChecksum"].is_string());
    }

    #[test]
    fn marker_v2_round_trip_without_metadata() {
        let raw = build_multipart_marker(
            "abc",
            0,
            1,
            "file.bin",
            1,
            "application/octet-stream",
            None,
            None,
            None,
            "0".repeat(64).as_str(),
        );
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert!(value["metadata"].is_null());
        assert!(value["caption"].is_null());
        assert!(value["checksum"].is_null());
        assert_eq!(value["partChecksum"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn hex_encode_known_vector() {
        // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let h = Sha256::new().finalize();
        let hex = hex_encode(&h);
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn pause_control_toggle() {
        let p = UploadPauseControl::new();
        assert!(!p.is_paused());
        p.pause();
        assert!(p.is_paused());
        p.resume();
        assert!(!p.is_paused());
    }

    #[test]
    fn abort_control_toggle() {
        let a = UploadAbortControl::new();
        assert!(!a.is_aborted());
        a.abort();
        assert!(a.is_aborted());
    }

    #[test]
    fn upload_progress_carries_chunk_position() {
        let p = UploadProgress {
            bytes_uploaded: 512 * 1024,
            total_bytes: 50 * 1024 * 1024,
            chunk_index: 0,
            total_chunks: 1,
            chunk_bytes_uploaded: 512 * 1024,
        };
        assert_eq!(p.bytes_uploaded, 524_288);
        assert_eq!(p.chunk_index, 0);
        assert_eq!(p.chunk_bytes_uploaded, 524_288);
    }

    /// `InvocationError` → `StorageError` mapping should classify
    /// `FLOOD_WAIT_*` as retriable + carry the server delay.
    #[test]
    fn retry_delay_honours_flood_wait() {
        let err = StorageError::RateLimited {
            retry_after_seconds: 7,
        };
        assert_eq!(retry_delay_ms(&err, 0), 7000);
        assert_eq!(retry_delay_ms(&err, 5), 7000);
    }

    #[test]
    fn retry_delay_exponential() {
        let err = StorageError::Telegram("transient".into());
        assert_eq!(retry_delay_ms(&err, 0), BACKOFF_BASE_MS);
        assert_eq!(retry_delay_ms(&err, 1), BACKOFF_BASE_MS * 2);
        assert_eq!(retry_delay_ms(&err, 2), BACKOFF_BASE_MS * 4);
        // Caps at BACKOFF_CAP_MS.
        let big = retry_delay_ms(&err, 20);
        assert!(big <= BACKOFF_CAP_MS);
    }

    fn rpc(code: i32, message: &str) -> grammers_client::InvocationError {
        grammers_client::InvocationError::Rpc(grammers_mtsender::RpcError::from(
            tl::types::RpcError {
                error_code: code,
                error_message: message.into(),
            },
        ))
    }

    #[test]
    fn is_transient_classifies_invocation_errors() {
        use grammers_client::InvocationError as E;
        // Connection-level failures retry.
        assert!(is_transient(&E::Io(std::io::Error::other("reset"))));
        assert!(is_transient(&E::Dropped));
        // Floods, server-side errors and timeouts retry.
        assert!(is_transient(&rpc(420, "FLOOD_WAIT_7")));
        assert!(is_transient(&rpc(420, "FLOOD_PREMIUM_WAIT_3")));
        assert!(is_transient(&rpc(500, "INTERNAL")));
        assert!(is_transient(&rpc(500, "RPC_CALL_FAIL")));
        assert!(is_transient(&rpc(-503, "Timeout")));
        assert!(is_transient(&rpc(400, "STORAGE_CHECK_TIMEOUT")));
        // Request-level errors are permanent: resending identical bytes
        // can't fix them.
        assert!(!is_transient(&rpc(400, "FILE_PART_TOO_BIG")));
        assert!(!is_transient(&rpc(400, "FILE_PARTS_INVALID")));
        assert!(!is_transient(&rpc(400, "FILE_PART_SIZE_CHANGED")));
        assert!(!is_transient(&rpc(400, "FILE_PART_EMPTY")));
        assert!(!is_transient(&rpc(401, "AUTH_KEY_UNREGISTERED")));
        assert!(!is_transient(&E::InvalidDc));
    }

    #[test]
    fn part_mode_follows_10mb_threshold() {
        assert_eq!(PartMode::for_chunk_size(0), PartMode::Big);
        assert_eq!(PartMode::for_chunk_size(1), PartMode::Small);
        assert_eq!(PartMode::for_chunk_size(SMALL_FILE_MAX_BYTES), PartMode::Small);
        assert_eq!(PartMode::for_chunk_size(SMALL_FILE_MAX_BYTES + 1), PartMode::Big);
        // A full video chunk always uses the big-file path.
        assert_eq!(PartMode::for_chunk_size(MAX_CHUNK_BYTES), PartMode::Big);
        // Small path stays well within saveFilePart's part-count limit.
        assert!(SMALL_FILE_MAX_BYTES.div_ceil(MT_PART_SIZE as u64) <= 4000);
    }

    #[test]
    fn check_abort_propagates_when_flag_set() {
        let abort = Arc::new(UploadAbortControl::new());
        check_abort(Some(&abort)).expect("not aborted yet");
        abort.abort();
        assert!(matches!(
            check_abort(Some(&abort)),
            Err(StorageError::UploadAborted)
        ));
        // None path stays Ok.
        check_abort(None).unwrap();
    }

    #[tokio::test]
    async fn wait_while_paused_unblocks_when_resumed() {
        let pause = Arc::new(UploadPauseControl::new());
        wait_while_paused(None).await; // no-op
        wait_while_paused(Some(&pause)).await; // not paused → returns immediately

        pause.pause();
        let p_clone = pause.clone();
        let handle = tokio::spawn(async move {
            wait_while_paused(Some(&p_clone)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!handle.is_finished());
        pause.resume();
        let r = tokio::time::timeout(std::time::Duration::from_millis(500), handle).await;
        assert!(
            r.is_ok(),
            "expected wait_while_paused to return after resume"
        );
    }

    #[tokio::test]
    async fn piece_source_buffer_yields_pieces_then_stops() {
        let mut src: PieceSource<'_, std::io::Cursor<Vec<u8>>> = PieceSource::Buffer {
            data: vec![1u8, 2, 3, 4, 5],
            offset: 0,
        };
        // Two pieces of 2, then the 1-byte remainder.
        assert_eq!(src.next_piece(2).await.unwrap(), vec![1, 2]);
        assert_eq!(src.next_piece(2).await.unwrap(), vec![3, 4]);
        // Asking for more than remains yields only what's left.
        assert_eq!(src.next_piece(2).await.unwrap(), vec![5]);
        // Fully drained.
        assert!(src.next_piece(2).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn piece_source_stream_reads_exact_and_errors_on_short() {
        use std::io::Cursor;
        let mut reader = Cursor::new(vec![9u8, 8, 7, 6]);
        let mut src = PieceSource::Stream(&mut reader);
        assert_eq!(src.next_piece(3).await.unwrap(), vec![9, 8, 7]);
        // Only 1 byte left but 3 requested → the caller mis-sized the chunk.
        let err = src.next_piece(3).await.unwrap_err();
        assert!(matches!(err, StorageError::BadRequest(_)));
    }

    #[tokio::test]
    async fn read_exact_or_eof_returns_short_read_on_eof() {
        use std::io::Cursor;
        let mut reader = Cursor::new(vec![1u8, 2, 3]);
        let mut buf = vec![0u8; 10];
        let n = read_exact_or_eof(&mut reader, &mut buf).await.unwrap();
        assert_eq!(n, 3);
        assert_eq!(&buf[..3], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn read_exact_or_eof_fills_when_stream_has_enough() {
        use std::io::Cursor;
        let mut reader = Cursor::new(vec![1u8, 2, 3, 4, 5]);
        let mut buf = vec![0u8; 3];
        let n = read_exact_or_eof(&mut reader, &mut buf).await.unwrap();
        assert_eq!(n, 3);
        assert_eq!(buf, vec![1, 2, 3]);
    }

    #[test]
    fn upload_request_builder_attaches_all_optional_fields() {
        let progress: UploadProgressCallback = Arc::new(|_| {});
        let chunk_cb: ChunkCompletionCallback = Arc::new(|_| {});
        let pause = Arc::new(UploadPauseControl::new());
        let abort = Arc::new(UploadAbortControl::new());
        let req = UploadRequest::new("name.mp4", "video/mp4", 1024)
            .with_metadata(serde_json::json!({ "k": "v" }))
            .with_text("a text")
            .with_progress(progress)
            .with_chunk_callback(chunk_cb)
            .with_pause(pause)
            .with_abort(abort);
        assert_eq!(req.name, "name.mp4");
        assert_eq!(req.mime_type, "video/mp4");
        assert_eq!(req.total_size_bytes, 1024);
        assert!(req.metadata.is_some());
        assert_eq!(req.text.as_deref(), Some("a text"));
        assert!(req.progress.is_some());
        assert!(req.chunk_callback.is_some());
        assert!(req.pause.is_some());
        assert!(req.abort.is_some());
    }

    #[tokio::test]
    async fn paused_reader_blocks_until_resumed() {
        use std::io::Cursor;
        use tokio::io::AsyncReadExt;

        let pause = Arc::new(UploadPauseControl::new());
        let buf = vec![1u8, 2, 3, 4];
        let reader = Cursor::new(buf);
        let mut wrapped = paused_reader(reader, pause.clone());

        // Initially not paused → reads through.
        let mut out = vec![0u8; 2];
        let n = wrapped.read(&mut out).await.unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, vec![1, 2]);

        // Pause and try to read with a short timeout — should not complete.
        pause.pause();
        let mut second = vec![0u8; 2];
        let timeout = tokio::time::timeout(
            std::time::Duration::from_millis(150),
            wrapped.read(&mut second),
        )
        .await;
        assert!(timeout.is_err(), "expected timeout while paused");

        // Resume and try again — should complete now.
        pause.resume();
        let n = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            wrapped.read(&mut second),
        )
        .await
        .expect("read should complete after resume")
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(second, vec![3, 4]);
    }

    #[test]
    fn chunk_completion_carries_position() {
        let c = ChunkCompletion {
            chunk_index: 1,
            total_chunks: 5,
            chunk_size_bytes: 1024,
            bytes_uploaded: 2048,
            total_bytes: 5120,
            completed_count: 2,
            skipped: false,
        };
        assert_eq!(c.chunk_index, 1);
        assert_eq!(c.total_chunks, 5);
        assert_eq!(c.bytes_uploaded, 2048);
        assert_eq!(c.completed_count, 2);
        assert!(!c.skipped);
    }
}
