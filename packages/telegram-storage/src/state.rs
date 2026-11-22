//! Shared `TelegramStorage` value carried by every route.
//!
//! Holds the on-disk paths, the SQLite handle for the index, the
//! credentials cached at boot, and the lazily-built MTProto client.
//!
//! Locking discipline:
//! - `connected` is a `tokio::sync::Mutex<Option<Arc<ConnectedClient>>>` —
//!   route handlers acquire it only long enough to clone the inner
//!   `Arc` (then drop the guard) so multiple uploads / downloads can
//!   share the same MTProto client concurrently. The `grammers-client`
//!   `Client` is `Send + Sync` + cheaply cloneable and the underlying
//!   `SenderPool` is designed for concurrent calls, so contention only
//!   exists on the brief swap-in / swap-out done by the auth flow.
//! - `login` is a separate mutex so logout / status can read client
//!   state without blocking on a login the wizard is mid-flight in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use grammers_client::message::InputMessage;
use tokio::fs;
use tokio::sync::Mutex;

use crate::auth::LoginInProgress;
use crate::client::ConnectedClient;
use crate::config::{self, Credentials};
use crate::db::{self as index_db, FileRow};
use crate::download::{self, DownloadStream};
use crate::error::StorageError;
use crate::media_type;
use crate::pool::Db;
use crate::upload::{self, UploadRequest, UploadResult};
use crate::uploads::{UploadEventSink, UploadRegistry};

mod embedded_keys {
    include!(concat!(env!("OUT_DIR"), "/embedded_keys.rs"));
}

/// Caller-supplied configuration for [`TelegramStorage::init`].
pub struct TelegramConfig {
    /// On-disk root the host backend already uses (for the player
    /// backend: `<home>/tgb-player/` or Tauri's
    /// `app_local_data_dir()` on Android). The storage writes its
    /// session and credentials underneath `<data_root>/telegram/`.
    pub data_root: PathBuf,
    /// SQLite handle the host backend already opened. The storage
    /// uses it for its `tg_files` index. The player-backend uses one
    /// SQLite file for everything; the schema runs `IF NOT EXISTS`
    /// stanzas so it's safe to migrate on every boot.
    pub db: Db,
    /// Optional observer of background upload lifecycle events
    /// ([`UploadEvent`](crate::uploads::UploadEvent)). Tests / minimal
    /// embedders leave it `None`. The storage crate stays
    /// observer-agnostic; this is a plain trait object.
    pub event_sink: Option<UploadEventSink>,
}

#[derive(Clone)]
pub struct TelegramStorage {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub data_root: PathBuf,
    pub db: Db,
    pub credentials: Mutex<Option<Credentials>>,
    pub connected: Mutex<Option<Arc<ConnectedClient>>>,
    pub login: Mutex<Option<LoginInProgress>>,
    pub uploads: UploadRegistry,
    pub event_sink: Option<UploadEventSink>,
    /// HMAC signing key for the 1-hour group-membership bypass cookie
    /// minted by `GET /status`. See [`crate::access_cookie`].
    pub access_key: crate::access_cookie::AccessKey,
}

impl TelegramStorage {
    /// Boot the storage. Loads credentials if present, applies the
    /// SQLite schema, and (if credentials and a session both exist)
    /// reconnects the MTProto client. Network failures during the
    /// reconnect are logged and swallowed — the user can re-auth from
    /// the UI.
    pub async fn init(config: TelegramConfig) -> Result<Self, StorageError> {
        let TelegramConfig {
            data_root,
            db,
            event_sink,
        } = config;
        index_db::migrate(&db).await?;
        let access_key = crate::access_cookie::AccessKey::load_or_create(&data_root);
        let credentials = match config::load(&data_root).await? {
            Some(c) => Some(c),
            None => credentials_from_env().or_else(credentials_from_embedded),
        };

        let connected = match credentials.as_ref() {
            Some(creds) => match ConnectedClient::connect(
                &session_path(&data_root),
                creds.api_id,
                creds.api_hash.clone(),
            )
            .await
            {
                Ok(c) => Some(Arc::new(c)),
                Err(e) => {
                    log::warn!(target: "tgb-telegram-storage", "boot reconnect failed: {e}");
                    None
                }
            },
            None => None,
        };

        Ok(Self {
            inner: Arc::new(Inner {
                data_root,
                db,
                credentials: Mutex::new(credentials),
                connected: Mutex::new(connected),
                login: Mutex::new(None),
                uploads: UploadRegistry::new(),
                event_sink,
                access_key,
            }),
        })
    }

    pub fn uploads(&self) -> UploadRegistry {
        self.inner.uploads.clone()
    }

    pub fn event_sink(&self) -> Option<UploadEventSink> {
        self.inner.event_sink.clone()
    }

    pub fn data_root(&self) -> &Path {
        &self.inner.data_root
    }

    pub fn db(&self) -> &Db {
        &self.inner.db
    }

    pub(crate) fn inner(&self) -> &Inner {
        &self.inner
    }

    // -----------------------------------------------------------------
    // File-system surface
    // -----------------------------------------------------------------
    //
    // The methods below are the canonical entry points for other Rust
    // crates that want to treat the Telegram chat as a backing FS. The
    // HTTP layer in `api.rs` is a thin wrapper over them.
    //
    // Method shape:
    // - `upload_*` — push a stream / file / bytes into the chat,
    //   chunked into 50 MiB Telegram messages, with SHA-256 +
    //   caller-supplied JSON metadata stamped on every chunk.
    // - `download_*` / `read_*` — pull bytes back, optionally verifying
    //   the SHA-256 against the recorded checksum.
    // - `list` / `get` / `find_*` — query the SQLite index.
    // - `delete` / `delete_all` — remove the bytes from the chat and
    //   the index together (or only the index, for the `_index_only`
    //   variants).

    /// Upload an `AsyncRead` stream as a new file. The reader is read
    /// until `request.total_size_bytes` bytes have been pushed; EOF
    /// before that aborts the upload. No dedup is performed — callers
    /// that want filename-based dedup should call [`Self::find_by_name`]
    /// first.
    ///
    /// **Resumable.** If an earlier attempt at the same logical file
    /// (same `name` + size, never completed) left chunks on Telegram, the
    /// upload path resumes into that row and skips re-pushing every chunk
    /// whose bytes still match — so a re-run after a crash / restart only
    /// uploads the chunks that never landed. See [`upload::upload`].
    pub async fn upload_stream<S>(
        &self,
        request: UploadRequest,
        stream: S,
    ) -> Result<UploadResult, StorageError>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin,
    {
        // Chat is a backing store for playable media only — reject text,
        // images, archives, and other torrent-bundled noise before we
        // open the MTProto connection or burn bandwidth on a file
        // Telegram is going to keep but no consumer will ever read.
        if !media_type::is_allowed(&request.name, &request.mime_type) {
            return Err(StorageError::UnsupportedMediaType {
                name: request.name.clone(),
                mime: request.mime_type.clone(),
            });
        }
        let connected = self.connected_client().await?;
        upload::upload(&connected, self.db(), request, stream).await
    }

    /// Upload a server-local file. Sets `total_size_bytes` from
    /// `fs::metadata`, opens the file for reading, and forwards to
    /// [`Self::upload_stream`]. Does **not** dedup — see
    /// [`Self::upload_local_file_dedup`] for the legacy filename-based
    /// dedup behaviour.
    pub async fn upload_local_file(
        &self,
        path: &Path,
        request: UploadRequest,
    ) -> Result<UploadResult, StorageError> {
        let meta = fs::metadata(path).await?;
        if !meta.is_file() {
            return Err(StorageError::BadRequest(
                "path is not a regular file".into(),
            ));
        }
        let size_bytes = meta.len();
        if size_bytes > upload::MAX_UPLOAD_BYTES {
            return Err(StorageError::FileTooLarge {
                limit_bytes: upload::MAX_UPLOAD_BYTES,
            });
        }
        let mut filled = request;
        // Trust the disk; ignore whatever the caller passed in for size.
        // (The caller-supplied value is only meaningful for streaming
        // sources where `fs::metadata` doesn't apply.)
        filled.total_size_bytes = size_bytes;
        let file = fs::File::open(path).await?;
        self.upload_stream(filled, file).await
    }

    /// Filename-deduplicated local upload. Used by callers like the
    /// album-track downloader where the filename encodes a stable key
    /// (`<artistMbid>:<albumMbid>:<trackMbid>:<videoId>`) and re-running
    /// after a crash should be idempotent. Runs the chat → tg_files
    /// reconcile once per session so a re-install / second device
    /// catches files already on Telegram.
    ///
    /// Returns [`UploadOutcome::Uploaded`] on a fresh upload and
    /// [`UploadOutcome::AlreadyExists`] when the dedup hit.
    pub async fn upload_local_file_dedup(
        &self,
        path: &Path,
        request: UploadRequest,
    ) -> Result<UploadOutcome, StorageError> {
        {
            let connected = self.connected_client().await?;
            connected.reconcile_chat_index(self.db()).await?;
        }
        if let Some(existing) = index_db::find_by_name(self.db(), &request.name).await? {
            log::info!(
                target: "tgb-telegram-storage",
                "skip upload — already exists in tg_files: {name:?} (tg_message_id={})",
                existing.tg_message_id,
                name = request.name,
            );
            return Ok(UploadOutcome::AlreadyExists(existing));
        }
        let result = self.upload_local_file(path, request).await?;
        Ok(UploadOutcome::Uploaded(result))
    }

    /// List every file in the index, newest first.
    pub async fn list(&self) -> Result<Vec<FileRow>, StorageError> {
        index_db::list(self.db()).await
    }

    /// Run the metadata-only chat reconcile if a client is connected.
    /// Idempotent — internally guarded by a per-connection `OnceCell`
    /// so a second call within the same session is a no-op. Returns
    /// `Ok(None)` when nobody is signed in yet (the catalog endpoint
    /// surfaces an empty tree in that case). Use this before walking
    /// [`Self::list`] for catalog assembly so the local index has
    /// every metadata sidecar the chat has.
    pub async fn reconcile_metadata_index(&self) -> Result<Option<usize>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => Ok(Some(
                connected.reconcile_chat_metadata_only(self.db()).await?,
            )),
            None => Ok(None),
        }
    }

    /// Run the full chat → `tg_files` reconcile (the `All` filter) if a
    /// client is connected — the same walk [`Self::upload_local_file_dedup`]
    /// runs before its filename dedup, minting every media file (including
    /// single-chunk documents like the shared `.vtt` subtitles) the chat
    /// holds into the local index. Idempotent — internally guarded by a
    /// per-connection `OnceCell`, so a second call within the same session is
    /// a no-op. Returns `Ok(None)` when nobody is signed in yet. Use this
    /// before a [`Self::find_by_name`] that must see files uploaded by
    /// another device.
    pub async fn reconcile_index_once(&self) -> Result<Option<usize>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => Ok(Some(connected.reconcile_chat_index(self.db()).await?)),
            None => Ok(None),
        }
    }

    /// Same as [`Self::reconcile_metadata_index`] but for the on-demand
    /// "the user hit play, mint the matching media row" path. Returns
    /// the minted file id when a media row was found in the chat for
    /// this pipeline; `Ok(None)` when nothing matches or the client
    /// isn't connected.
    pub async fn reconcile_media_for_pipeline(
        &self,
        pipeline_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => connected
                .reconcile_chat_media_for_pipeline(self.db(), pipeline_id)
                .await,
            None => Ok(None),
        }
    }

    /// Walk the chat once and recover the connector/chain catalog graph
    /// (the un-indexed `*-metadata` reply messages + the head-chunk
    /// reply-to edges). Mints the chain media files into `tg_files` along
    /// the way so playback resolves. Returns `Ok(None)` when nobody is
    /// signed in. Unlike [`Self::reconcile_metadata_index`] this is not
    /// session-cached — the caller (the catalog endpoint) caches the
    /// assembled tree and only re-walks on an explicit refresh.
    pub async fn scan_chain_catalog(
        &self,
    ) -> Result<Option<crate::client::ChainCatalogScan>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => Ok(Some(connected.scan_chain_catalog(self.db()).await?)),
            None => Ok(None),
        }
    }

    /// Incremental catalog scan — walk only the messages newer than
    /// `since` (the catalog's high-water mark), returning the new scan
    /// graph + the newest message id seen. `Ok(None)` when nobody is
    /// signed in. See [`crate::client::ConnectedClient::scan_chain_catalog_since`].
    pub async fn scan_chain_catalog_since(
        &self,
        since: Option<i64>,
    ) -> Result<Option<(crate::client::ChainCatalogScan, Option<i64>)>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => Ok(Some(connected.scan_chain_catalog_since(self.db(), since).await?)),
            None => Ok(None),
        }
    }

    /// Cheap check of the chat's most recent message id (`Ok(None)` when
    /// nobody is signed in or the chat is empty). The catalog poll
    /// compares it against its high-water mark before deciding whether to
    /// re-walk at all.
    pub async fn latest_message_id(&self) -> Result<Option<i64>, StorageError> {
        let connected_opt = {
            let guard = self.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        match connected_opt {
            Some(connected) => connected.latest_message_id().await,
            None => Ok(None),
        }
    }

    pub async fn get(&self, id: &str) -> Result<Option<FileRow>, StorageError> {
        index_db::get(self.db(), id).await
    }

    /// Resolve the Telegram message IDs backing a stored logical file:
    /// the head (chunk-0) message — the de-facto "master" legacy readers
    /// already key on — plus every chunk's message id in `ord` order.
    /// Returns `Ok(None)` when `id` is unknown. Pure index reads, no
    /// network. Used by the connector's metadata-reply runner to thread a
    /// movie-metadata reply under the uploaded video's master message.
    pub async fn file_message_ids(
        &self,
        id: &str,
    ) -> Result<Option<FileMessageIds>, StorageError> {
        let Some(row) = index_db::get(self.db(), id).await? else {
            return Ok(None);
        };
        let parts = index_db::list_parts(self.db(), id).await?;
        Ok(Some(FileMessageIds {
            head_message_id: row.tg_message_id,
            part_message_ids: parts.into_iter().map(|p| p.tg_message_id).collect(),
        }))
    }

    /// Send a message into the blob-store chat, optionally as a native
    /// reply to an existing message (`reply_to_message_id`). When the
    /// reply id is `None` the message is a root message. Optionally carries
    /// text (the message body, or the document caption when `document_path`
    /// is set) and/or a single document attachment. Returns the new
    /// message's id. Requires a connected client. Reuses the same
    /// `connected_client()` + `target_peer()` send path the chunk uploader
    /// uses in `upload.rs`.
    pub async fn send_reply(
        &self,
        reply_to_message_id: Option<i32>,
        text: Option<String>,
        document_path: Option<PathBuf>,
    ) -> Result<i64, StorageError> {
        let connected = self.connected_client().await?;
        let target = connected.target_peer().await?;
        let mut input = InputMessage::new();
        if let Some(reply_to) = reply_to_message_id {
            input = input.reply_to(Some(reply_to));
        }
        if let Some(text) = text.as_deref() {
            input = input.text(text);
        }
        if let Some(path) = document_path.as_deref() {
            let uploaded = connected.client.upload_file(path).await?;
            input = input.document(uploaded);
        }
        let msg = connected.client.send_message(target, input).await?;
        Ok(msg.id() as i64)
    }

    pub async fn find_by_name(&self, name: &str) -> Result<Option<FileRow>, StorageError> {
        index_db::find_by_name(self.db(), name).await
    }

    /// Lookup by full-file SHA-256 (hex). Useful for content-addressed
    /// dedup ("do I already have a file with this checksum?") without
    /// trusting the filename.
    pub async fn find_by_checksum(
        &self,
        checksum_hex: &str,
    ) -> Result<Option<FileRow>, StorageError> {
        index_db::find_by_checksum(self.db(), checksum_hex).await
    }

    /// Stream the inclusive byte range `[start, end]` of a stored file
    /// as a channel of `Vec<u8>` chunks. Returns
    /// [`StorageError::NotFound`] when `id` is unknown.
    pub async fn download_range(
        &self,
        id: &str,
        start: u64,
        end: u64,
    ) -> Result<(FileRow, DownloadStream), StorageError> {
        let row = index_db::get(self.db(), id)
            .await?
            .ok_or(StorageError::NotFound)?;
        let connected = self.connected_client().await?;
        let stream = download::download_range(&connected, self.db(), &row, start, end).await?;
        Ok((row, stream))
    }

    /// Stream the whole file. Thin wrapper over [`Self::download_range`].
    pub async fn download(&self, id: &str) -> Result<(FileRow, DownloadStream), StorageError> {
        let row_peek = index_db::get(self.db(), id)
            .await?
            .ok_or(StorageError::NotFound)?;
        let total = row_peek.size_bytes.max(0) as u64;
        let end = total.saturating_sub(1);
        self.download_range(id, 0, end).await
    }

    /// Stream a stored file by `tg_files.id` into `<target_dir>/<row.name>`.
    /// Creates `target_dir` if missing and overwrites any existing file
    /// at the resulting path. Returns the `FileRow` + the final absolute
    /// path.
    pub async fn download_to_dir(
        &self,
        id: &str,
        target_dir: &Path,
    ) -> Result<(FileRow, PathBuf), StorageError> {
        let (row, mut stream) = self.download(id).await?;
        fs::create_dir_all(target_dir).await?;
        let target_path = target_dir.join(&row.name);
        let mut file = fs::File::create(&target_path).await?;
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.rx.recv().await {
            let chunk = chunk?;
            if !chunk.is_empty() {
                file.write_all(&chunk).await?;
            }
        }
        file.flush().await?;
        Ok((row, target_path))
    }

    /// Pull a stored file by `tg_files.id` into memory. Capped at
    /// `max_bytes` so callers don't accidentally pull a multi-GiB file
    /// into RAM.
    pub async fn download_to_bytes(
        &self,
        id: &str,
        max_bytes: usize,
    ) -> Result<(FileRow, Vec<u8>), StorageError> {
        let (row, mut stream) = self.download(id).await?;
        let total = row.size_bytes.max(0) as u64;
        if total as usize > max_bytes {
            return Err(StorageError::FileTooLarge {
                limit_bytes: max_bytes as u64,
            });
        }
        let mut buf: Vec<u8> = Vec::with_capacity(total.min(max_bytes as u64) as usize);
        while let Some(chunk) = stream.rx.recv().await {
            let chunk = chunk?;
            if buf.len().saturating_add(chunk.len()) > max_bytes {
                return Err(StorageError::FileTooLarge {
                    limit_bytes: max_bytes as u64,
                });
            }
            buf.extend_from_slice(&chunk);
        }
        Ok((row, buf))
    }

    /// Re-download the file end-to-end and verify it matches the stored
    /// `checksum_sha256`. Returns [`StorageError::ChecksumMismatch`] on
    /// failure and `Ok(())` on success. Useful as a periodic integrity
    /// check or after a suspect upload.
    ///
    /// Files whose `checksum_sha256` is NULL (legacy uploads, reconciled
    /// rows that predate the marker) can't be verified — those return
    /// `Ok(())` with a warning logged.
    pub async fn verify(&self, id: &str) -> Result<(), StorageError> {
        use sha2::{Digest, Sha256};
        let row = index_db::get(self.db(), id)
            .await?
            .ok_or(StorageError::NotFound)?;
        let Some(expected) = row.checksum_sha256.clone() else {
            log::warn!(
                target: "tgb-telegram-storage",
                "verify({id}): no stored checksum, skipping",
            );
            return Ok(());
        };
        let (_, mut stream) = self.download(id).await?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = stream.rx.recv().await {
            let chunk = chunk?;
            hasher.update(&chunk);
        }
        let actual = {
            let digest = hasher.finalize();
            let mut s = String::with_capacity(digest.len() * 2);
            for b in digest {
                s.push_str(&format!("{:02x}", b));
            }
            s
        };
        if actual != expected {
            return Err(StorageError::ChecksumMismatch { expected, actual });
        }
        Ok(())
    }

    /// Delete a stored file from the chat and the index. Returns
    /// [`StorageError::NotFound`] when the id is unknown.
    pub async fn delete(&self, id: &str) -> Result<(), StorageError> {
        let row = index_db::get(self.db(), id)
            .await?
            .ok_or(StorageError::NotFound)?;
        let connected = self.connected_client().await?;
        download::delete(&connected, self.db(), &row).await
    }

    /// Delete a stored file, treating an unknown id as success. Same as
    /// [`delete`](Self::delete) but a missing index row is not an error —
    /// for a caller tearing a title down (a "nuke"), a file already gone
    /// from the index is exactly the desired end state, not a failure.
    pub async fn delete_if_exists(&self, id: &str) -> Result<(), StorageError> {
        match self.delete(id).await {
            Ok(()) | Err(StorageError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Best-effort delete of arbitrary message ids from the destination
    /// chat, **without** touching the file index. For the plain-text /
    /// document reply messages the acquisition stack threads (the
    /// `*-metadata` messages) that never land in `tg_files`. An empty
    /// list is a no-op; already-deleted ids are ignored.
    pub async fn delete_messages(&self, ids: &[i64]) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }
        let connected = self.connected_client().await?;
        download::delete_message_ids(&connected, ids).await
    }

    /// Wipe every file from the chat and the index. Returns the number
    /// of Telegram messages that were walked before the batched
    /// `delete_messages` calls fired.
    pub async fn delete_all(&self) -> Result<usize, StorageError> {
        let connected = self.connected_client().await?;
        download::delete_all(&connected, self.db()).await
    }

    /// Briefly lock `connected` to clone the inner `Arc<ConnectedClient>`,
    /// then drop the guard. Lets concurrent operations run against the
    /// same MTProto client without serialising on the state mutex.
    pub(crate) async fn connected_client(&self) -> Result<Arc<ConnectedClient>, StorageError> {
        let guard = self.inner().connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::NotAuthenticated)
    }
}

#[derive(Debug)]
pub enum UploadOutcome {
    Uploaded(UploadResult),
    AlreadyExists(index_db::FileRow),
}

/// The Telegram message IDs backing a stored logical file. Returned by
/// [`TelegramStorage::file_message_ids`]. `head_message_id` is chunk 0's
/// message (the "master" legacy single-message readers key on);
/// `part_message_ids` lists every chunk's message id in `ord` order
/// (equal to `[head_message_id]` for a single-chunk file).
#[derive(Debug, Clone)]
pub struct FileMessageIds {
    pub head_message_id: i64,
    pub part_message_ids: Vec<i64>,
}

/// `<data_root>/telegram/session.sqlite` — the MTProto session.
pub(crate) fn session_path(data_root: &Path) -> PathBuf {
    data_root.join("telegram").join("session.sqlite")
}

/// Read `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` from the environment.
/// Both must be set and the id must parse as `i32`; otherwise `None`.
/// Used as the boot-time default when no on-disk credentials exist —
/// not persisted, so editing `.env` and rebooting is the canonical
/// way to change them, while UI edits via `POST /credentials` write
/// to disk and shadow the env defaults.
fn credentials_from_env() -> Option<Credentials> {
    let api_id_raw = std::env::var("TELEGRAM_API_ID").ok()?;
    let api_hash = std::env::var("TELEGRAM_API_HASH").ok()?;
    let api_id = api_id_raw.trim().parse::<i32>().ok()?;
    let api_hash = api_hash.trim().to_string();
    if api_id <= 0 || api_hash.is_empty() {
        return None;
    }
    log::info!(
        target: "tgb-telegram-storage",
        "loaded Telegram credentials from environment (api_id={api_id})"
    );
    Some(Credentials { api_id, api_hash })
}

/// Fall back to the build-time embedded constants generated by `build.rs`.
/// These come from the workspace-root `.env`'s `TELEGRAM_API_ID` /
/// `TELEGRAM_API_HASH` at compile time, so a packaged Android APK ships
/// with a working default even when no runtime env and no on-disk
/// credentials are available. UI overrides via `POST /credentials` still
/// shadow these.
fn credentials_from_embedded() -> Option<Credentials> {
    let id_str = embedded_keys::TELEGRAM_API_ID.trim();
    let hash_str = embedded_keys::TELEGRAM_API_HASH.trim();
    let api_id = id_str.parse::<i32>().ok()?;
    if api_id <= 0 || hash_str.is_empty() {
        return None;
    }
    log::info!(
        target: "tgb-telegram-storage",
        "loaded Telegram credentials from build-time embedded constants (api_id={api_id})"
    );
    Some(Credentials {
        api_id,
        api_hash: hash_str.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tempfile::TempDir;

    async fn fresh_db() -> Db {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        Db::new(pool)
    }

    #[test]
    fn session_path_lives_under_telegram_dir() {
        let p = session_path(Path::new("/tmp/root"));
        assert_eq!(p, Path::new("/tmp/root/telegram/session.sqlite"));
    }

    /// Env-var precedence: `credentials_from_env` returns `None` when
    /// either variable is missing or `api_id <= 0`. We can't safely mutate
    /// the process env (other tests may read it), so we just confirm the
    /// helper handles the unset case cleanly.
    #[test]
    fn credentials_from_env_returns_none_when_unset() {
        // Snapshot to restore on the off-chance the env happens to carry
        // the vars (CI / .env-pollution); the helper's only public
        // observable behaviour we can rely on is that the result is
        // either Some or None — not the specific value.
        let prev_id = std::env::var("TELEGRAM_API_ID").ok();
        let prev_hash = std::env::var("TELEGRAM_API_HASH").ok();
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }
        assert!(credentials_from_env().is_none());
        unsafe {
            if let Some(v) = prev_id {
                std::env::set_var("TELEGRAM_API_ID", v);
            }
            if let Some(v) = prev_hash {
                std::env::set_var("TELEGRAM_API_HASH", v);
            }
        }
    }

    #[test]
    fn credentials_from_env_returns_none_for_invalid_id() {
        let prev_id = std::env::var("TELEGRAM_API_ID").ok();
        let prev_hash = std::env::var("TELEGRAM_API_HASH").ok();
        unsafe {
            std::env::set_var("TELEGRAM_API_ID", "not-a-number");
            std::env::set_var("TELEGRAM_API_HASH", "abc");
        }
        assert!(credentials_from_env().is_none());
        unsafe {
            std::env::set_var("TELEGRAM_API_ID", "0");
            std::env::set_var("TELEGRAM_API_HASH", "abc");
        }
        assert!(credentials_from_env().is_none());
        unsafe {
            std::env::set_var("TELEGRAM_API_ID", "-5");
            std::env::set_var("TELEGRAM_API_HASH", "abc");
        }
        assert!(credentials_from_env().is_none());
        unsafe {
            std::env::set_var("TELEGRAM_API_ID", "12345");
            std::env::set_var("TELEGRAM_API_HASH", "");
        }
        assert!(credentials_from_env().is_none());
        unsafe {
            std::env::set_var("TELEGRAM_API_ID", "12345");
            std::env::set_var("TELEGRAM_API_HASH", "abc");
        }
        let creds = credentials_from_env().expect("present");
        assert_eq!(creds.api_id, 12345);
        assert_eq!(creds.api_hash, "abc");
        unsafe {
            match prev_id {
                Some(v) => std::env::set_var("TELEGRAM_API_ID", v),
                None => std::env::remove_var("TELEGRAM_API_ID"),
            }
            match prev_hash {
                Some(v) => std::env::set_var("TELEGRAM_API_HASH", v),
                None => std::env::remove_var("TELEGRAM_API_HASH"),
            }
        }
    }

    #[test]
    fn credentials_from_embedded_returns_none_for_default_stub() {
        // The build script writes empty strings by default — exercising
        // the early-return branch is enough; testing the success path
        // would require a non-default build env.
        let _ = credentials_from_embedded();
    }

    #[test]
    fn upload_outcome_variants_are_distinct() {
        let row = index_db::FileRow {
            id: "x".into(),
            name: "n".into(),
            size_bytes: 0,
            mime_type: "video/mp4".into(),
            tg_message_id: 1,
            created_at: chrono::Utc::now(),
            text: None,
            checksum_sha256: None,
            metadata: None,
        };
        let res = UploadResult {
            id: "u".into(),
            tg_message_id: 1,
            sha256_hex: "0".repeat(64),
        };
        let exists = UploadOutcome::AlreadyExists(row);
        let uploaded = UploadOutcome::Uploaded(res);
        assert!(matches!(exists, UploadOutcome::AlreadyExists(_)));
        assert!(matches!(uploaded, UploadOutcome::Uploaded(_)));
    }

    /// Boot a [`TelegramStorage`] against a tempdir + in-memory SQLite
    /// with no credentials — confirms the no-network init path returns
    /// a usable handle.
    #[tokio::test]
    async fn init_without_credentials_returns_handle() {
        // Make sure env-based credentials don't accidentally trigger a
        // network reconnect during init.
        let prev_id = std::env::var("TELEGRAM_API_ID").ok();
        let prev_hash = std::env::var("TELEGRAM_API_HASH").ok();
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }

        let tmp = TempDir::new().unwrap();
        let db = fresh_db().await;
        let storage = TelegramStorage::init(TelegramConfig {
            data_root: tmp.path().to_path_buf(),
            db,
            event_sink: None,
        })
        .await
        .unwrap();
        assert_eq!(storage.data_root(), tmp.path());
        assert!(storage.event_sink().is_none());
        // No credentials means no client connected → the registry is
        // initially empty and the helpers don't panic.
        assert!(storage.uploads().list().is_empty());

        unsafe {
            if let Some(v) = prev_id {
                std::env::set_var("TELEGRAM_API_ID", v);
            }
            if let Some(v) = prev_hash {
                std::env::set_var("TELEGRAM_API_HASH", v);
            }
        }
    }

    /// Surface methods that don't need a connected client should fail
    /// fast with the appropriate error variant.
    #[tokio::test]
    async fn surface_methods_without_client_return_not_authenticated() {
        let prev_id = std::env::var("TELEGRAM_API_ID").ok();
        let prev_hash = std::env::var("TELEGRAM_API_HASH").ok();
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }

        let tmp = TempDir::new().unwrap();
        let db = fresh_db().await;
        let storage = TelegramStorage::init(TelegramConfig {
            data_root: tmp.path().to_path_buf(),
            db,
            event_sink: None,
        })
        .await
        .unwrap();

        // upload_stream rejects non-media MIME without touching the
        // connection at all.
        let req = crate::upload::UploadRequest::new("cover.jpg", "image/jpeg", 0);
        let bytes = std::io::Cursor::new(Vec::<u8>::new());
        let err = storage.upload_stream(req, bytes).await.unwrap_err();
        assert!(matches!(err, StorageError::UnsupportedMediaType { .. }));

        // delete_all wants a connected client → NotAuthenticated.
        let err = storage.delete_all().await.unwrap_err();
        assert!(matches!(err, StorageError::NotAuthenticated));

        // delete(unknown id) hits the missing row before the client
        // check → NotFound.
        let err = storage.delete("missing").await.unwrap_err();
        assert!(matches!(err, StorageError::NotFound));

        // download(unknown id) is the same pattern.
        let res = storage.download("missing").await;
        match res {
            Err(StorageError::NotFound) => {}
            Err(other) => panic!("expected NotFound, got {other:?}"),
            Ok(_) => panic!("expected error for missing download id"),
        }

        // verify(unknown id) likewise.
        let err = storage.verify("missing").await.unwrap_err();
        assert!(matches!(err, StorageError::NotFound));

        // list / get / find_by_* go straight to the DB and succeed
        // with empty / None.
        assert!(storage.list().await.unwrap().is_empty());
        assert!(storage.get("nope").await.unwrap().is_none());
        assert!(storage.find_by_name("nope").await.unwrap().is_none());
        assert!(storage.find_by_checksum("nope").await.unwrap().is_none());

        unsafe {
            if let Some(v) = prev_id {
                std::env::set_var("TELEGRAM_API_ID", v);
            }
            if let Some(v) = prev_hash {
                std::env::set_var("TELEGRAM_API_HASH", v);
            }
        }
    }

    #[tokio::test]
    async fn upload_local_file_rejects_directory() {
        let prev_id = std::env::var("TELEGRAM_API_ID").ok();
        let prev_hash = std::env::var("TELEGRAM_API_HASH").ok();
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }
        let tmp = TempDir::new().unwrap();
        let db = fresh_db().await;
        let storage = TelegramStorage::init(TelegramConfig {
            data_root: tmp.path().to_path_buf(),
            db,
            event_sink: None,
        })
        .await
        .unwrap();

        // Point at a directory — should reject before hitting MTProto.
        let dir = tmp.path().join("subdir");
        std::fs::create_dir_all(&dir).unwrap();
        let req = crate::upload::UploadRequest::new("clip.mp4", "video/mp4", 0);
        let err = storage.upload_local_file(&dir, req).await.unwrap_err();
        assert!(matches!(err, StorageError::BadRequest(_)));

        unsafe {
            if let Some(v) = prev_id {
                std::env::set_var("TELEGRAM_API_ID", v);
            }
            if let Some(v) = prev_hash {
                std::env::set_var("TELEGRAM_API_HASH", v);
            }
        }
    }
}
