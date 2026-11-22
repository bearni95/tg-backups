//! Telegram-backed file storage for the on-device backend.
//!
//! Exposes a small Axum router (mounted at `/api/telegram` by the host
//! backend) that lets the frontend log a Telegram user in via MTProto,
//! upload arbitrary files into a per-app private megagroup, list them,
//! download them, and delete them.
//!
//! The crate is designed to be embedded by the Tgb Go on-device
//! backend (see `apps/go/` + `packages/player-backend/`). Player and
//! Cloud do not enable it; the heavy MTProto dependency tree is
//! confined to this crate.
//!
//! # Architecture
//!
//! - **Shared group as blob store (when access-gated).** When
//!   `TGB_TELEGRAM_ACCESS_GROUP` is set, that single group is BOTH the
//!   login-gate group and the storage destination: every authorized
//!   member reads and writes the *same* group, so a file uploaded by one
//!   member is visible to all of them (one shared catalog). The group is
//!   created once out-of-band by whoever owns the spec (invite link,
//!   `@username`, or numeric id); the crate only resolves and reuses it —
//!   it never creates a group in this mode. See
//!   [`client::ConnectedClient::target_peer`].
//!
//! - **No fallback store.** With `TGB_TELEGRAM_ACCESS_GROUP` unset,
//!   storage operations fail — the crate never creates a per-user group
//!   and never uses Saved Messages. The index in SQLite is the
//!   authoritative file list, Telegram is just bytes.
//!
//! - **Two SQLite tables** (`tg_files` head row + `tg_file_part`
//!   per-chunk rows) make up the local index. Each file is chunked into
//!   ≤ [`crate::upload::MAX_CHUNK_BYTES`] (50 MiB) Telegram messages,
//!   each carrying its own SHA-256 and the caller-supplied JSON
//!   metadata as a structured `tgb-multipart` caption. Listing is a
//!   SQLite read; Telegram is only touched on upload/download/delete.
//!
//! - **Session and credentials live under the data root.** The session
//!   state is persisted as JSON via [`session::FileSession`] at
//!   `<data_root>/telegram/session.sqlite` (the `.sqlite` filename is
//!   historical — the file used to be a libsql/sqlite blob and we kept
//!   the name to avoid a migration). User-supplied `api_id` / `api_hash`
//!   are stored at `<data_root>/telegram/credentials.json`. Both files
//!   are inside the host backend's private data dir (sandboxed on
//!   Android), so we don't reach for the OS keychain in v1.
//!
//! - **One in-process client.** A `tokio::sync::Mutex<Option<Client>>`
//!   holds the authenticated client; the in-progress login token (if
//!   any) lives in a separate mutex. Route handlers acquire the client
//!   lock for the duration of an MTProto call. There is no background
//!   updates loop yet — every operation is request-driven.
//!
//! # What is intentionally not implemented (v1)
//!
//! - Folders (the index is a flat list).
//! - Pinned-message index sync (the channel is not self-describing).
//! - Streaming via Range requests (downloads are full-file).
//! - Invite-link sharing.
//! - Thumbnails.
//! - Background daemons / retry queues.
//!
//! All of those slot into this crate without breaking the router shape.

pub mod access_cookie;
pub mod api;
pub mod auth;
mod backup;
pub mod client;
pub mod config;
pub mod db;
pub mod download;
pub mod error;
pub mod media_type;
pub mod pool;
pub mod session;
pub mod state;
pub mod upload;
pub mod uploads;

pub use api::router;
pub use client::{ChainCatalogScan, ChainMetaMessage, MediaLink};
pub use db::{FilePart, FileRow};
pub use download::DownloadStream;
pub use error::StorageError;
pub use pool::Db;
pub use state::{FileMessageIds, TelegramConfig, TelegramStorage, UploadOutcome};
pub use upload::{
    ChunkCompletion, ChunkCompletionCallback, UploadAbortControl, UploadPauseControl,
    UploadProgress, UploadProgressCallback, UploadRequest, UploadResult, MAX_CHUNK_BYTES,
    MAX_UPLOAD_BYTES,
};
pub use uploads::{UploadEvent, UploadEventSink, UploadRegistry, UploadSnapshot, UploadStatus};
