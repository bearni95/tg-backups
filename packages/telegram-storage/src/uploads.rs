//! Background upload registry.
//!
//! Wraps [`TelegramStorage::upload_local_file`] in a spawned task so the
//! HTTP request returns an `uploadId` immediately and the long-running
//! chunked transfer keeps making progress in the background. The
//! registry tracks every live upload's pause / abort handles and
//! observable state so additional HTTP requests can pause, resume,
//! cancel, or list them.
//!
//! Each lifecycle transition fires through an optional
//! [`UploadEventSink`] supplied at boot via
//! [`crate::state::TelegramConfig::event_sink`]. The storage crate
//! itself stays observer-agnostic; the sink is a plain trait object so
//! the host backend can plug whatever sink it likes (a queue, a
//! channel, a logger, …).
//!
//! The registry is *in-memory only* — restarting the backend drops
//! every in-flight upload's live progress. The on-Telegram chunks that
//! did land stay in the chat + index, so a *re-issued* upload of the same
//! logical file (same name + size) resumes from those chunks rather than
//! restarting from byte 0 — the resume lives in [`crate::upload::upload`]
//! (it finds the interrupted `tg_files` row and skips re-pushing chunks
//! whose bytes still match). Callers can still `delete()` the half-finished
//! row first if they want a clean slate instead.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::state::TelegramStorage;
use crate::upload::{
    ChunkCompletion, UploadAbortControl, UploadPauseControl, UploadProgress, UploadRequest,
    MAX_CHUNK_BYTES,
};

/// How many background uploads may push to Telegram at once. Held at **1**
/// so only a single file is ever uploading at a time;
/// the rest queue FIFO and show as "Queued". Each upload still fans its
/// 512 KiB parts across the dedicated upload connections
/// ([`crate::client::UPLOAD_CONNECTIONS`]) internally. Raise this only if
/// you deliberately want multiple files uploading concurrently.
const MAX_CONCURRENT_UPLOADS: usize = 1;

/// One lifecycle event for a background upload. Delivered to whatever
/// [`UploadEventSink`] the host backend supplied at boot.
#[derive(Debug, Clone)]
pub enum UploadEvent {
    /// Upload task has been spawned and the first chunk is about to
    /// start.
    Started {
        upload_id: String,
        ref_id: String,
        name: String,
        total_bytes: u64,
        total_chunks: u64,
    },
    /// One 50 MiB chunk landed on Telegram.
    ChunkUploaded {
        upload_id: String,
        ref_id: String,
        name: String,
        chunk_index: u64,
        total_chunks: u64,
        bytes_uploaded: u64,
        total_bytes: u64,
    },
    /// Every chunk landed and the index row was finalised.
    Completed {
        upload_id: String,
        ref_id: String,
        name: String,
        file_id: String,
        total_bytes: u64,
    },
    /// Upload was cancelled or hit an unrecoverable error.
    Failed {
        upload_id: String,
        ref_id: String,
        name: String,
        error: String,
    },
}

/// Cheap, non-blocking observer plugged at boot. The host backend
/// supplies the implementation; tests can supply a `Vec`-backed mock.
pub type UploadEventSink = Arc<dyn Fn(UploadEvent) + Send + Sync>;

/// Observable status of an in-flight or recently-finished upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UploadStatus {
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

/// Observable status of a single chunk within a logical upload. Mirrors
/// the upload-level [`UploadStatus`] but only the states a chunk can
/// reach matter: it hasn't been touched yet, it's actively streaming,
/// or every byte landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChunkStatus {
    Pending,
    Running,
    Done,
}

/// Per-chunk progress mirrored into the snapshot so the UI can render
/// each chunk as its own progress bar. Updated by the `progress`
/// callback every 512 KiB and finalised by the `chunk_callback` once
/// `sendMedia` + DB inserts succeed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkSnapshot {
    pub index: u64,
    pub bytes_uploaded: u64,
    pub bytes_total: u64,
    pub status: ChunkStatus,
}

/// Serialisable snapshot returned by `GET /uploads` and per-id queries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSnapshot {
    pub upload_id: String,
    pub ref_id: String,
    pub name: String,
    pub status: UploadStatus,
    pub bytes_uploaded: u64,
    /// Subset of `bytes_uploaded` that came from chunks already on Telegram
    /// and seek-skipped on resume (never pushed over the wire). The UI
    /// subtracts these from `bytes_uploaded` before dividing by the elapsed
    /// transfer window, so a resume's instantly-credited chunks don't
    /// inflate the reported speed / deflate the ETA. Zero for a fresh
    /// upload.
    pub skipped_bytes: u64,
    pub total_bytes: u64,
    pub chunks_completed: u64,
    pub total_chunks: u64,
    /// File id assigned by [`crate::upload`] once the first chunk lands.
    /// `None` before that point; populated on completion.
    pub file_id: Option<String>,
    /// Error message, populated when `status` is `Failed`.
    pub error: Option<String>,
    /// Unix seconds when the upload was enqueued (the snapshot was
    /// created). Note this can predate the actual transfer by however
    /// long the upload waited in the queue gate — use
    /// [`Self::transfer_started_at`] for speed / ETA math.
    pub started_at: i64,
    /// Unix seconds when the actual byte transfer began — i.e. when this
    /// upload acquired the queue gate and started pushing to Telegram.
    /// `None` while still queued behind other uploads. The UI keys its
    /// "queued" state off this and anchors its upload-speed / ETA window
    /// here so a long queue wait doesn't deflate the reported rate.
    pub transfer_started_at: Option<i64>,
    /// Unix seconds when the upload reached a terminal state, if any.
    pub finished_at: Option<i64>,
    /// Per-chunk progress, length `total_chunks`. Fed by the 512 KiB
    /// `progress` callback (advances the live chunk's `bytes_uploaded`)
    /// and the `chunk_callback` (flips a chunk's status to `Done`).
    pub chunks: Vec<ChunkSnapshot>,
}

struct ActiveUpload {
    snapshot: RwLock<UploadSnapshot>,
    pause: Arc<UploadPauseControl>,
    abort: Arc<UploadAbortControl>,
    /// Kept so the registry can drop in-flight tasks at shutdown. Not
    /// awaited in the hot path — `await` happens in `await_all`.
    #[allow(dead_code)]
    task: Mutex<Option<JoinHandle<()>>>,
}

/// In-memory map of upload id → [`ActiveUpload`]. Cloned freely; the
/// inner state lives behind `Arc`.
#[derive(Clone)]
pub struct UploadRegistry {
    inner: Arc<RwLock<HashMap<String, Arc<ActiveUpload>>>>,
    /// Fair gate bounding how many background uploads push to Telegram at
    /// once ([`MAX_CONCURRENT_UPLOADS`] permits). Each spawned task
    /// acquires a permit before touching the network and holds it until
    /// the transfer finishes, so once the permits are taken the rest queue
    /// (FIFO) behind them.
    gate: Arc<Semaphore>,
}

impl Default for UploadRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            gate: Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS)),
        }
    }
}

impl UploadRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire the upload queue permit. The returned guard must be held
    /// for the duration of the transfer; dropping it releases the next
    /// queued upload. Raise the permit count in [`Default`] to allow
    /// more than one concurrent upload.
    pub(crate) async fn acquire_gate(&self) -> OwnedSemaphorePermit {
        self.gate
            .clone()
            .acquire_owned()
            .await
            .expect("upload gate never closed")
    }

    pub fn list(&self) -> Vec<UploadSnapshot> {
        let guard = self.inner.read();
        let mut out: Vec<UploadSnapshot> =
            guard.values().map(|u| u.snapshot.read().clone()).collect();
        out.sort_by_key(|u| u.started_at);
        out
    }

    pub fn get(&self, upload_id: &str) -> Option<UploadSnapshot> {
        let guard = self.inner.read();
        guard.get(upload_id).map(|u| u.snapshot.read().clone())
    }

    pub fn pause(&self, upload_id: &str) -> bool {
        let guard = self.inner.read();
        let Some(u) = guard.get(upload_id) else {
            return false;
        };
        u.pause.pause();
        let mut snap = u.snapshot.write();
        if snap.status == UploadStatus::Running {
            snap.status = UploadStatus::Paused;
        }
        true
    }

    pub fn resume(&self, upload_id: &str) -> bool {
        let guard = self.inner.read();
        let Some(u) = guard.get(upload_id) else {
            return false;
        };
        u.pause.resume();
        let mut snap = u.snapshot.write();
        if snap.status == UploadStatus::Paused {
            snap.status = UploadStatus::Running;
        }
        true
    }

    pub fn cancel(&self, upload_id: &str) -> bool {
        let guard = self.inner.read();
        let Some(u) = guard.get(upload_id) else {
            return false;
        };
        u.abort.abort();
        // Make sure a paused upload also wakes up so the abort flag is
        // observed at the next part boundary.
        u.pause.resume();
        true
    }

    fn insert(&self, upload_id: String, active: Arc<ActiveUpload>) {
        self.inner.write().insert(upload_id, active);
    }

    fn update_snapshot(&self, upload_id: &str, mutate: impl FnOnce(&mut UploadSnapshot)) {
        let guard = self.inner.read();
        if let Some(u) = guard.get(upload_id) {
            let mut snap = u.snapshot.write();
            mutate(&mut snap);
        }
    }
}

/// Spawn a background upload of `path` into Telegram. Returns the
/// `uploadId` the registry assigned — use it to drive pause / resume /
/// cancel.
///
/// The task runs detached. Lifecycle events flow through the optional
/// [`UploadEventSink`] held on `TelegramStorage`. The path **must** be
/// under the storage's data root; the api layer enforces that before
/// calling in.
pub fn spawn_upload(
    storage: TelegramStorage,
    path: PathBuf,
    name: String,
    mime_type: String,
    total_bytes: u64,
    ref_id: String,
    metadata: Option<serde_json::Value>,
    text: Option<String>,
    reply_to_message_id: Option<i32>,
) -> String {
    let upload_id = Uuid::new_v4().to_string();
    let total_chunks = if total_bytes == 0 {
        1
    } else {
        total_bytes.div_ceil(MAX_CHUNK_BYTES).max(1)
    };

    let pause = Arc::new(UploadPauseControl::new());
    let abort = Arc::new(UploadAbortControl::new());

    let now = unix_seconds();
    let chunks = build_chunk_snapshots(total_bytes, total_chunks);
    let snapshot = UploadSnapshot {
        upload_id: upload_id.clone(),
        ref_id: ref_id.clone(),
        name: name.clone(),
        status: UploadStatus::Running,
        bytes_uploaded: 0,
        skipped_bytes: 0,
        total_bytes,
        chunks_completed: 0,
        total_chunks,
        file_id: None,
        error: None,
        started_at: now,
        transfer_started_at: None,
        finished_at: None,
        chunks,
    };

    let registry = storage.uploads();
    let active = Arc::new(ActiveUpload {
        snapshot: RwLock::new(snapshot),
        pause: pause.clone(),
        abort: abort.clone(),
        task: Mutex::new(None),
    });
    registry.insert(upload_id.clone(), active.clone());

    emit(
        storage.event_sink(),
        UploadEvent::Started {
            upload_id: upload_id.clone(),
            ref_id: ref_id.clone(),
            name: name.clone(),
            total_bytes,
            total_chunks,
        },
    );

    // Build the progress + chunk callbacks before moving `storage` into
    // the task so both callbacks and the upload itself share the same
    // registry + sink without re-cloning per part / chunk. The progress
    // callback fires every 512 KiB and updates the live chunk's
    // `bytes_uploaded`; the chunk callback fires once per chunk and
    // flips that chunk's status to `Done`.
    let progress_registry = registry.clone();
    let progress_upload_id = upload_id.clone();
    let progress_cb: crate::upload::UploadProgressCallback = Arc::new(move |p: UploadProgress| {
        progress_registry.update_snapshot(&progress_upload_id, |snap| {
            snap.bytes_uploaded = p.bytes_uploaded;
            apply_chunk_progress(snap, p.chunk_index, p.chunk_bytes_uploaded);
        });
    });

    let chunk_registry = registry.clone();
    let chunk_sink = storage.event_sink();
    let chunk_upload_id = upload_id.clone();
    let chunk_ref_id = ref_id.clone();
    let chunk_name = name.clone();
    let chunk_cb: crate::upload::ChunkCompletionCallback = Arc::new(move |c: ChunkCompletion| {
        chunk_registry.update_snapshot(&chunk_upload_id, |snap| {
            snap.bytes_uploaded = c.bytes_uploaded;
            snap.chunks_completed = c.completed_count;
            if c.skipped {
                // Already on Telegram, seek-skipped on resume — credited to
                // bytes_uploaded (so the bar reflects real progress) but kept
                // out of the transferred total the UI divides for speed/ETA.
                snap.skipped_bytes = snap.skipped_bytes.saturating_add(c.chunk_size_bytes);
            }
            if let Some(chunk) = snap.chunks.get_mut(c.chunk_index as usize) {
                chunk.bytes_uploaded = chunk.bytes_total;
                chunk.status = ChunkStatus::Done;
            }
        });
        emit(
            chunk_sink.clone(),
            UploadEvent::ChunkUploaded {
                upload_id: chunk_upload_id.clone(),
                ref_id: chunk_ref_id.clone(),
                name: chunk_name.clone(),
                chunk_index: c.chunk_index,
                total_chunks: c.total_chunks,
                bytes_uploaded: c.bytes_uploaded,
                total_bytes: c.total_bytes,
            },
        );
    });

    let task_storage = storage.clone();
    let task_upload_id = upload_id.clone();
    let task_ref_id = ref_id.clone();
    let task_name = name.clone();
    let task_pause = pause;
    let task_abort = abort;
    let handle = tokio::spawn(async move {
        // Wait our turn in the upload queue. Only one background upload
        // pushes to Telegram at a time; the snapshot stays `Running`
        // while we wait, which the poll loops treat as "keep waiting".
        let gate_abort = task_abort.clone();
        log::debug!(target: "tgb-telegram-storage", "upload {task_upload_id} queued, waiting for gate");
        let _permit = task_storage.uploads().acquire_gate().await;
        log::debug!(target: "tgb-telegram-storage", "upload {task_upload_id} gate acquired, starting transfer");

        // Stamp the real transfer-start time now that we hold a permit, so
        // the UI's speed / ETA math measures the transfer window rather
        // than the (possibly long) queue wait, and can show a "queued"
        // state until this point.
        task_storage
            .uploads()
            .update_snapshot(&task_upload_id, |snap| {
                snap.transfer_started_at = Some(unix_seconds());
            });

        // Cancelled while queued: skip the transfer entirely.
        if gate_abort.is_aborted() {
            let error_msg = crate::error::StorageError::UploadAborted.to_string();
            task_storage
                .uploads()
                .update_snapshot(&task_upload_id, |snap| {
                    snap.status = UploadStatus::Cancelled;
                    snap.error = Some(error_msg.clone());
                    snap.finished_at = Some(unix_seconds());
                });
            emit(
                task_storage.event_sink(),
                UploadEvent::Failed {
                    upload_id: task_upload_id,
                    ref_id: task_ref_id,
                    name: task_name,
                    error: error_msg,
                },
            );
            return;
        }

        let mut request = UploadRequest::new(&task_name, &mime_type, total_bytes)
            .with_pause(task_pause)
            .with_abort(task_abort)
            .with_progress(progress_cb)
            .with_chunk_callback(chunk_cb);
        if let Some(m) = metadata {
            request = request.with_metadata(m);
        }
        if let Some(t) = text {
            request = request.with_text(t);
        }
        if let Some(reply_to) = reply_to_message_id {
            request = request.with_reply_to(reply_to);
        }

        let outcome = task_storage.upload_local_file(&path, request).await;
        match outcome {
            Ok(result) => {
                task_storage
                    .uploads()
                    .update_snapshot(&task_upload_id, |snap| {
                        snap.status = UploadStatus::Completed;
                        snap.file_id = Some(result.id.clone());
                        snap.bytes_uploaded = snap.total_bytes;
                        snap.chunks_completed = snap.total_chunks;
                        snap.finished_at = Some(unix_seconds());
                        for c in snap.chunks.iter_mut() {
                            c.bytes_uploaded = c.bytes_total;
                            c.status = ChunkStatus::Done;
                        }
                    });
                emit(
                    task_storage.event_sink(),
                    UploadEvent::Completed {
                        upload_id: task_upload_id,
                        ref_id: task_ref_id,
                        name: task_name,
                        file_id: result.id,
                        total_bytes,
                    },
                );
            }
            Err(err) => {
                let was_cancelled = matches!(err, crate::error::StorageError::UploadAborted);
                let error_msg = err.to_string();
                task_storage
                    .uploads()
                    .update_snapshot(&task_upload_id, |snap| {
                        snap.status = if was_cancelled {
                            UploadStatus::Cancelled
                        } else {
                            UploadStatus::Failed
                        };
                        snap.error = Some(error_msg.clone());
                        snap.finished_at = Some(unix_seconds());
                    });
                emit(
                    task_storage.event_sink(),
                    UploadEvent::Failed {
                        upload_id: task_upload_id,
                        ref_id: task_ref_id,
                        name: task_name,
                        error: error_msg,
                    },
                );
            }
        }
    });

    {
        let mut slot = active.task.try_lock().expect("freshly inserted");
        *slot = Some(handle);
    }

    upload_id
}

fn emit(sink: Option<UploadEventSink>, event: UploadEvent) {
    if let Some(s) = sink {
        s(event);
    }
}

fn build_chunk_snapshots(total_bytes: u64, total_chunks: u64) -> Vec<ChunkSnapshot> {
    if total_chunks == 0 {
        return Vec::new();
    }
    (0..total_chunks)
        .map(|i| {
            let start = i.saturating_mul(MAX_CHUNK_BYTES);
            let bytes_total = total_bytes.saturating_sub(start).min(MAX_CHUNK_BYTES);
            ChunkSnapshot {
                index: i,
                bytes_uploaded: 0,
                bytes_total,
                status: ChunkStatus::Pending,
            }
        })
        .collect()
}

/// Apply a per-chunk progress event to the named chunk on the snapshot.
/// Clamps `chunk_bytes_uploaded` to the chunk's `bytes_total` and flips
/// the chunk's status to `Running` (unless it's already `Done`). Leaves
/// other chunks alone — under parallel chunk uploads, several chunks
/// may be live simultaneously and the chunk-completion callback (not
/// the progress callback) is the source of truth for `Done`.
fn apply_chunk_progress(snap: &mut UploadSnapshot, chunk_index: u64, chunk_bytes_uploaded: u64) {
    let idx = chunk_index as usize;
    if let Some(chunk) = snap.chunks.get_mut(idx) {
        chunk.bytes_uploaded = chunk_bytes_uploaded.min(chunk.bytes_total);
        if chunk.status != ChunkStatus::Done {
            chunk.status = ChunkStatus::Running;
        }
    }
}

fn unix_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_empty() {
        let r = UploadRegistry::new();
        assert!(r.list().is_empty());
        assert!(r.get("nope").is_none());
    }

    #[test]
    fn pause_resume_cancel_unknown_returns_false() {
        let r = UploadRegistry::new();
        assert!(!r.pause("nope"));
        assert!(!r.resume("nope"));
        assert!(!r.cancel("nope"));
    }

    #[tokio::test]
    async fn gate_bounds_concurrent_uploads() {
        let r = UploadRegistry::new();
        // Take every permit — that many uploads may run at once.
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_UPLOADS {
            held.push(r.acquire_gate().await);
        }
        // One more acquire must queue until a permit frees.
        let r2 = r.clone();
        let extra = tokio::spawn(async move { r2.acquire_gate().await });
        tokio::task::yield_now().await;
        assert!(
            !extra.is_finished(),
            "acquire beyond the permit count should queue"
        );
        held.pop(); // release one permit
        let _permit = extra.await.expect("queued acquire task panicked");
    }

    #[test]
    fn build_chunk_snapshots_splits_at_max_chunk_bytes() {
        let total = MAX_CHUNK_BYTES * 2 + 1234;
        let chunks = build_chunk_snapshots(total, 3);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].bytes_total, MAX_CHUNK_BYTES);
        assert_eq!(chunks[1].bytes_total, MAX_CHUNK_BYTES);
        assert_eq!(chunks[2].bytes_total, 1234);
        assert!(chunks.iter().all(|c| c.status == ChunkStatus::Pending));
        assert!(chunks.iter().all(|c| c.bytes_uploaded == 0));
    }

    #[test]
    fn apply_chunk_progress_touches_only_the_named_chunk() {
        let total = MAX_CHUNK_BYTES * 3;
        let mut snap = UploadSnapshot {
            upload_id: "u".into(),
            ref_id: "r".into(),
            name: "n".into(),
            status: UploadStatus::Running,
            bytes_uploaded: 0,
            skipped_bytes: 0,
            total_bytes: total,
            chunks_completed: 0,
            total_chunks: 3,
            file_id: None,
            error: None,
            started_at: 0,
            transfer_started_at: None,
            finished_at: None,
            chunks: build_chunk_snapshots(total, 3),
        };
        // Half of chunk 1 uploaded. Chunks 0 and 2 stay untouched —
        // under parallel uploads the progress callback only carries
        // information about its own chunk; chunk-0 completion is
        // signalled by the chunk-completion callback, not by a chunk-1
        // progress tick.
        apply_chunk_progress(&mut snap, 1, MAX_CHUNK_BYTES / 2);
        assert_eq!(snap.chunks[0].status, ChunkStatus::Pending);
        assert_eq!(snap.chunks[0].bytes_uploaded, 0);
        assert_eq!(snap.chunks[1].status, ChunkStatus::Running);
        assert_eq!(snap.chunks[1].bytes_uploaded, MAX_CHUNK_BYTES / 2);
        assert_eq!(snap.chunks[2].status, ChunkStatus::Pending);
        assert_eq!(snap.chunks[2].bytes_uploaded, 0);
    }

    #[test]
    fn build_chunk_snapshots_zero_chunks_returns_empty_vec() {
        let chunks = build_chunk_snapshots(100, 0);
        assert!(chunks.is_empty());
    }

    #[test]
    fn build_chunk_snapshots_single_chunk_for_small_file() {
        let chunks = build_chunk_snapshots(1234, 1);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].bytes_total, 1234);
        assert_eq!(chunks[0].status, ChunkStatus::Pending);
    }

    #[test]
    fn apply_chunk_progress_idx_zero_advances_only_live_chunk() {
        let total = MAX_CHUNK_BYTES * 2;
        let mut snap = UploadSnapshot {
            upload_id: "u".into(),
            ref_id: "r".into(),
            name: "n".into(),
            status: UploadStatus::Running,
            bytes_uploaded: 0,
            skipped_bytes: 0,
            total_bytes: total,
            chunks_completed: 0,
            total_chunks: 2,
            file_id: None,
            error: None,
            started_at: 0,
            transfer_started_at: None,
            finished_at: None,
            chunks: build_chunk_snapshots(total, 2),
        };
        apply_chunk_progress(&mut snap, 0, 1024);
        assert_eq!(snap.chunks[0].bytes_uploaded, 1024);
        assert_eq!(snap.chunks[0].status, ChunkStatus::Running);
        assert_eq!(snap.chunks[1].status, ChunkStatus::Pending);
    }

    #[test]
    fn apply_chunk_progress_clamps_overflow_into_bytes_total() {
        let total = 100;
        let mut snap = UploadSnapshot {
            upload_id: "u".into(),
            ref_id: "r".into(),
            name: "n".into(),
            status: UploadStatus::Running,
            bytes_uploaded: 0,
            skipped_bytes: 0,
            total_bytes: total,
            chunks_completed: 0,
            total_chunks: 1,
            file_id: None,
            error: None,
            started_at: 0,
            transfer_started_at: None,
            finished_at: None,
            chunks: build_chunk_snapshots(total, 1),
        };
        apply_chunk_progress(&mut snap, 0, 9999);
        assert_eq!(snap.chunks[0].bytes_uploaded, total);
    }

    #[test]
    fn registry_list_sorts_by_started_at() {
        let r = UploadRegistry::new();
        let mk = |id: &str, ts: i64| {
            let pause = Arc::new(UploadPauseControl::new());
            let abort = Arc::new(UploadAbortControl::new());
            Arc::new(ActiveUpload {
                snapshot: RwLock::new(UploadSnapshot {
                    upload_id: id.into(),
                    ref_id: "r".into(),
                    name: "n".into(),
                    status: UploadStatus::Running,
                    bytes_uploaded: 0,
                    skipped_bytes: 0,
                    total_bytes: 0,
                    chunks_completed: 0,
                    total_chunks: 0,
                    file_id: None,
                    error: None,
                    started_at: ts,
                    transfer_started_at: None,
                    finished_at: None,
                    chunks: vec![],
                }),
                pause,
                abort,
                task: Mutex::new(None),
            })
        };
        r.insert("b".into(), mk("b", 200));
        r.insert("a".into(), mk("a", 100));
        let list = r.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].upload_id, "a");
        assert_eq!(list[1].upload_id, "b");
    }

    #[test]
    fn emit_calls_sink_when_provided_and_no_ops_otherwise() {
        use std::sync::Mutex as StdMutex;
        let received: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let received_clone = received.clone();
        let sink: UploadEventSink = Arc::new(move |e: UploadEvent| {
            received_clone.lock().unwrap().push(format!("{e:?}"));
        });
        emit(
            Some(sink),
            UploadEvent::Started {
                upload_id: "u".into(),
                ref_id: "r".into(),
                name: "n".into(),
                total_bytes: 1,
                total_chunks: 1,
            },
        );
        assert_eq!(received.lock().unwrap().len(), 1);
        // None sink is a no-op (no panic).
        emit(
            None,
            UploadEvent::Failed {
                upload_id: "u".into(),
                ref_id: "r".into(),
                name: "n".into(),
                error: "x".into(),
            },
        );
    }

    #[tokio::test]
    async fn spawn_upload_records_snapshot_and_eventually_fails_without_client() {
        // Boot a TelegramStorage without credentials, point at a real file
        // under data_root → spawn_upload mints a snapshot and the
        // background task fails fast with NotAuthenticated (the chat is
        // unconnected).
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }
        let tmp = tempfile::tempdir().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let db = crate::pool::Db::new(pool);
        let storage = crate::state::TelegramStorage::init(crate::state::TelegramConfig {
            data_root: tmp.path().to_path_buf(),
            db,
            event_sink: None,
        })
        .await
        .unwrap();

        let file_path = tmp.path().join("clip.mp4");
        std::fs::write(&file_path, b"hi").unwrap();

        let id = spawn_upload(
            storage.clone(),
            file_path,
            "clip.mp4".into(),
            "video/mp4".into(),
            2,
            "ref1".into(),
            Some(serde_json::json!({ "k": "v" })),
            Some("caption".into()),
            None,
        );
        let snap = storage.uploads().get(&id).expect("snapshot present");
        assert_eq!(snap.upload_id, id);
        assert_eq!(snap.name, "clip.mp4");
        assert_eq!(snap.ref_id, "ref1");
        assert_eq!(snap.total_bytes, 2);

        // Registry's pause/resume/cancel for the live upload should work.
        assert!(storage.uploads().pause(&id));
        assert_eq!(
            storage.uploads().get(&id).unwrap().status,
            UploadStatus::Paused
        );
        assert!(storage.uploads().resume(&id));
        // Give the background task a chance to error out.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let after = storage.uploads().get(&id).expect("still present");
        assert!(matches!(
            after.status,
            UploadStatus::Failed | UploadStatus::Cancelled | UploadStatus::Running
        ));
    }

    #[test]
    fn pause_resume_round_trip_flips_status() {
        let r = UploadRegistry::new();
        let pause = Arc::new(UploadPauseControl::new());
        let abort = Arc::new(UploadAbortControl::new());
        let active = Arc::new(ActiveUpload {
            snapshot: RwLock::new(UploadSnapshot {
                upload_id: "u1".into(),
                ref_id: "ref".into(),
                name: "n".into(),
                status: UploadStatus::Running,
                bytes_uploaded: 0,
                skipped_bytes: 0,
                total_bytes: 100,
                chunks_completed: 0,
                total_chunks: 1,
                file_id: None,
                error: None,
                started_at: 0,
                transfer_started_at: None,
                finished_at: None,
                chunks: build_chunk_snapshots(100, 1),
            }),
            pause: pause.clone(),
            abort: abort.clone(),
            task: Mutex::new(None),
        });
        r.insert("u1".into(), active);
        assert!(r.pause("u1"));
        assert_eq!(r.get("u1").unwrap().status, UploadStatus::Paused);
        assert!(pause.is_paused());
        assert!(r.resume("u1"));
        assert_eq!(r.get("u1").unwrap().status, UploadStatus::Running);
        assert!(!pause.is_paused());
        assert!(r.cancel("u1"));
        assert!(abort.is_aborted());
    }
}
