//! Wraps the boot sequence for `grammers-client`'s `SenderPool` +
//! `Client` into a single `ConnectedClient` value.
//!
//! `grammers-client` 0.9 separates the network sender (a `SenderPool`)
//! from the high-level `Client`. The sender owns a long-running
//! `runner` task; dropping it would close the connection. We hold the
//! `JoinHandle` so we can detect crashes (and shut it down on logout).
//!
//! The MTProto session is persisted via the crate's own
//! [`crate::session::FileSession`] — a JSON file separate from the host
//! backend's main DB so we can wipe it independently on logout.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use grammers_client::peer::User;
use grammers_client::Client;
use grammers_mtsender::SenderPool;
use grammers_session::types::PeerRef;
use grammers_tl_types as tl;

use crate::session::FileSession;
use tokio::sync::{Mutex, OnceCell};
use tokio::task::JoinHandle;

use crate::error::StorageError;

pub struct ConnectedClient {
    pub client: Client,
    pub session: Arc<FileSession>,
    pub api_id: i32,
    pub api_hash: String,
    /// JoinHandle for the SenderPool's `runner.run()` task. Kept so we
    /// can detect crashes and join on shutdown. Lives behind a Mutex so
    /// `shutdown(&self)` can take it out without consuming the
    /// `ConnectedClient` — needed because the value is shared as
    /// `Arc<ConnectedClient>` so concurrent uploads can borrow it
    /// without serialising on the outer state mutex.
    pub runner_task: Mutex<Option<JoinHandle<()>>>,
    /// Pool handle, retained so we can call `quit()` on logout to
    /// gracefully tear the runner down.
    pub pool_handle: grammers_mtsender::SenderPoolFatHandle,
    /// Lazily-resolved peer reference for the destination chat used by
    /// every upload / download / delete: the ONE shared group named by
    /// `TGB_TELEGRAM_ACCESS_GROUP` (see [`Self::target_peer`]). Every
    /// authorized member reads and writes it, so a file uploaded by any
    /// member is visible to all of them. Cached so the resolution
    /// round-trip happens at most once per connection.
    target_peer: OnceCell<PeerRef>,
    /// One-shot guard around the chat → SQLite `tg_files` reconcile. The
    /// first upload after this connection wakes up triggers a walk of the
    /// destination chat's message history and inserts a `tg_files` row
    /// for any document attachment we don't already have (matched by
    /// `tg_message_id`). Without this, a user who uploaded the same file
    /// from another device (or before this SQLite was created) would
    /// silently double-upload the bytes — local `find_by_name` dedup
    /// only sees what *this* device has previously written.
    pub(crate) index_reconciled: OnceCell<()>,
    /// Same shape as [`Self::index_reconciled`] but for the fast-path
    /// metadata-only walk used by the `/catalog` page on its initial
    /// scan. Tracked separately so a metadata-only walk doesn't pretend
    /// the full reconcile has run (and vice versa) — the catalog can
    /// land its scan quickly while the upload dedup path still gets to
    /// do its full chat walk on first upload.
    pub(crate) metadata_index_reconciled: OnceCell<()>,
    /// Optional access-control group identity (from
    /// `TGB_TELEGRAM_ACCESS_GROUP`). When `Some`, only Telegram accounts
    /// that belong to this group pass the login gate; `None` lets any
    /// signed-in account through. Accepts a private invite link
    /// (`t.me/+<hash>`), a public `@username`, or a numeric chat id (`-100…`
    /// supergroup form or the bare id). See [`access_group_from_env`].
    access_group: Option<String>,
    /// Cached membership verdict for this connection paired with the
    /// `Instant` it was probed: `Some((true, _))` member, `Some((false, _))`
    /// definitively not a member, `None` not yet checked (or the last check
    /// hit a transient error and should be retried). The verdict is treated
    /// as stale once older than [`ACCESS_CACHE_TTL`] so membership is
    /// re-verified against Telegram at most once an hour (matching the
    /// bypass-cookie lifetime). Reset by [`Self::recheck_access`] so an admin
    /// adding the user to the group can be picked up without restarting.
    access_cache: Mutex<Option<(bool, Instant)>>,
    /// Extra MTProto connections dedicated to upload (`saveBigFilePart`)
    /// fan-out, opened lazily on the first upload. See [`UPLOAD_CONNECTIONS`]
    /// and [`Self::ensure_upload_pool`].
    upload_pool: OnceCell<UploadPool>,
    /// Round-robin cursor over [`UploadPool::clients`].
    upload_rr: AtomicUsize,
}

/// Extra MTProto connections to the home DC opened solely for upload
/// (`saveBigFilePart`) fan-out. grammers' `SenderPool` keeps a single
/// connection per DC, which caps upload throughput at one in-flight
/// request stream; Telegram lets the same auth key drive several
/// simultaneous connections (this is how official clients parallelise
/// transfers), so we open a few dedicated upload sockets and round-robin
/// parts across them. Kept modest so we don't trip Telegram's per-account
/// connection limits.
pub const UPLOAD_CONNECTIONS: usize = 4;

/// A lazily-opened set of extra upload connections plus the round-robin
/// targets. See [`UPLOAD_CONNECTIONS`].
struct UploadPool {
    /// Clients to round-robin `saveBigFilePart` across. Either the
    /// freshly-opened extra senders, or `[main client]` when opening the
    /// extras failed (graceful degradation to a single connection).
    clients: Vec<Client>,
    /// The extra senders we own, kept so `shutdown` can quit them.
    extras: Vec<ExtraSender>,
}

/// One extra upload connection: the pool handle + its runner task, kept so
/// [`ConnectedClient::shutdown`] can tear it down gracefully.
struct ExtraSender {
    pool_handle: grammers_mtsender::SenderPoolFatHandle,
    runner: Mutex<Option<JoinHandle<()>>>,
}

/// How long a probed membership verdict stays fresh before the next
/// [`ConnectedClient::access_allowed`] re-probes. Matches
/// [`crate::access_cookie::TTL_SECS`].
const ACCESS_CACHE_TTL: Duration = Duration::from_secs(crate::access_cookie::TTL_SECS as u64);

impl ConnectedClient {
    /// Build a fresh client. Opens (or creates) the on-disk session
    /// file at `session_path`, spawns the sender pool runner, and
    /// returns a high-level `Client`.
    pub async fn connect(
        session_path: &Path,
        api_id: i32,
        api_hash: String,
    ) -> Result<Self, StorageError> {
        if let Some(parent) = session_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let session = Arc::new(
            FileSession::open(session_path)
                .await
                .map_err(|e| StorageError::Internal(format!("session open: {e}")))?,
        );

        let SenderPool {
            runner,
            updates: _,
            handle,
        } = SenderPool::new(Arc::clone(&session), api_id);
        let runner_task = tokio::spawn(runner.run());
        let client = Client::new(handle.clone());

        let access_group = access_group_from_env();
        if let Some(spec) = access_group.as_deref() {
            log::info!(
                target: "tgb-telegram-storage",
                "login gated on Telegram group membership (TGB_TELEGRAM_ACCESS_GROUP={spec:?})"
            );
        }

        Ok(Self {
            client,
            session,
            api_id,
            api_hash,
            runner_task: Mutex::new(Some(runner_task)),
            pool_handle: handle,
            target_peer: OnceCell::new(),
            index_reconciled: OnceCell::new(),
            metadata_index_reconciled: OnceCell::new(),
            access_group,
            access_cache: Mutex::new(None),
            upload_pool: OnceCell::new(),
            upload_rr: AtomicUsize::new(0),
        })
    }

    /// Open the dedicated upload connection pool if it isn't already. Call
    /// once at the start of an upload so the per-part [`Self::upload_client_rr`]
    /// pick is a cheap synchronous round-robin. Each extra sender shares
    /// this session's auth key (reused via grammers' `connect_with_auth`),
    /// so no re-login happens; a sender that fails to hand-shake is dropped,
    /// and if none come up the pool degrades to the single main client.
    pub(crate) async fn ensure_upload_pool(&self) {
        self.upload_pool
            .get_or_init(|| async {
                let mut clients = Vec::new();
                let mut extras = Vec::new();
                for i in 0..UPLOAD_CONNECTIONS {
                    let SenderPool {
                        runner,
                        updates: _,
                        handle,
                    } = SenderPool::new(Arc::clone(&self.session), self.api_id);
                    let task = tokio::spawn(runner.run());
                    let client = Client::new(handle.clone());
                    // Pre-warm: force the connection up (reusing the session
                    // auth key) so the first real part doesn't pay the connect
                    // cost, and so a rejected duplicate connection is dropped
                    // here rather than failing parts later.
                    match client.invoke(&tl::functions::help::GetConfig {}).await {
                        Ok(_) => {
                            clients.push(client);
                            extras.push(ExtraSender {
                                pool_handle: handle,
                                runner: Mutex::new(Some(task)),
                            });
                        }
                        Err(e) => {
                            log::warn!(
                                target: "tgb-telegram-storage",
                                "upload connection {i} failed to open ({e}); skipping"
                            );
                            handle.quit();
                            task.abort();
                        }
                    }
                }
                if clients.is_empty() {
                    log::info!(
                        target: "tgb-telegram-storage",
                        "no extra upload connections available; uploading over the main connection"
                    );
                    clients.push(self.client.clone());
                } else {
                    log::info!(
                        target: "tgb-telegram-storage",
                        "opened {} dedicated upload connection(s)",
                        clients.len()
                    );
                }
                UploadPool { clients, extras }
            })
            .await;
    }

    /// Round-robin pick of an upload connection. Cheap + synchronous — call
    /// [`Self::ensure_upload_pool`] once before the hot loop. Falls back to
    /// the main client if the pool somehow isn't initialised yet.
    pub(crate) fn upload_client_rr(&self) -> Client {
        match self.upload_pool.get() {
            Some(pool) if !pool.clients.is_empty() => {
                let idx = self.upload_rr.fetch_add(1, Ordering::Relaxed) % pool.clients.len();
                pool.clients[idx].clone()
            }
            _ => self.client.clone(),
        }
    }

    /// The configured access-control group identity, when login is gated on
    /// group membership. `None` means any signed-in account may use the app.
    pub fn access_group_spec(&self) -> Option<&str> {
        self.access_group.as_deref()
    }

    /// Whether the signed-in account clears the membership gate.
    ///
    /// Returns `Ok(true)` when gating is disabled or the user is a member,
    /// `Ok(false)` when the user is definitively *not* a member (so the gate
    /// should show the "not authorized" screen), and `Err` when the check
    /// couldn't be completed (a transient network error — the caller keeps
    /// the gate closed and the next status poll retries). The verdict is
    /// cached for up to [`ACCESS_CACHE_TTL`] (then re-probed);
    /// [`Self::recheck_access`] clears it immediately so a freshly-added
    /// member doesn't need a restart.
    pub async fn access_allowed(&self, me: &User) -> Result<bool, StorageError> {
        let Some(spec) = self.access_group.as_deref() else {
            return Ok(true);
        };
        if let Some((cached, at)) = *self.access_cache.lock().await {
            if at.elapsed() < ACCESS_CACHE_TTL {
                return Ok(cached);
            }
        }
        let verdict = self.probe_membership(spec, me).await?;
        *self.access_cache.lock().await = Some((verdict, Instant::now()));
        Ok(verdict)
    }

    /// Forget any cached membership verdict so the next [`Self::access_allowed`]
    /// re-runs the probe. Backs the `/access/recheck` route the "not a member"
    /// screen calls after an admin adds the user to the group.
    pub async fn recheck_access(&self) {
        *self.access_cache.lock().await = None;
    }

    /// Resolve the configured access group and ask Telegram whether `me` is a
    /// participant. Three spec shapes, checked in order:
    ///
    /// - **Private invite link** (`t.me/+<hash>` / `joinchat/<hash>` / a bare
    ///   `+<hash>`) — `messages.checkChatInvite` answers membership directly:
    ///   `ChatInviteAlready` means the calling account has already joined, any
    ///   other variant means it hasn't. This is the only shape that works for a
    ///   private group with no public username, addressed solely by its link.
    /// - **Public `@username`** — resolved via `resolve_username` (works
    ///   regardless of membership), then confirmed with `get_permissions`.
    /// - **Numeric chat id** — found by walking the user's own dialogs (a
    ///   member always has the group in their dialog list, so a miss already
    ///   means "not a member"), then confirmed with `get_permissions`
    ///   (`USER_NOT_PARTICIPANT` for outsiders).
    async fn probe_membership(&self, spec: &str, me: &User) -> Result<bool, StorageError> {
        if let Some(hash) = parse_invite_hash(spec) {
            return self.check_invite_membership(hash).await;
        }

        let group_ref = match parse_group_username(spec) {
            Some(uname) => match self.client.resolve_username(uname).await? {
                Some(peer) => peer.to_ref().await,
                None => {
                    log::warn!(
                        target: "tgb-telegram-storage",
                        "access group @{uname} could not be resolved (is it a public group?) — denying access"
                    );
                    return Ok(false);
                }
            },
            None => match parse_group_id_candidates(spec) {
                Some(ids) => self.find_dialog_peer_ref(&ids).await?,
                None => {
                    log::warn!(
                        target: "tgb-telegram-storage",
                        "access group spec {spec:?} is neither a username nor a numeric id — denying access"
                    );
                    return Ok(false);
                }
            },
        };

        let Some(group_ref) = group_ref else {
            // Public group resolved to no usable ref, or the numeric id is
            // absent from the user's dialogs (a member would have it).
            return Ok(false);
        };
        let Some(me_ref) = me.to_ref().await else {
            return Err(StorageError::Internal(
                "get_me().to_ref() returned None during membership check".into(),
            ));
        };
        match self.client.get_permissions(group_ref, me_ref).await {
            Ok(_) => Ok(true),
            Err(e) if e.is("USER_NOT_PARTICIPANT") => Ok(false),
            Err(e) => Err(StorageError::Telegram(format!(
                "group membership check failed: {e}"
            ))),
        }
    }

    /// Walk the user's dialogs once looking for a peer whose bare id matches
    /// one of `ids`. A member of the target group will have it in their dialog
    /// list, so a hit yields the `PeerRef` (with its access hash) the
    /// authoritative `get_permissions` check then needs.
    async fn find_dialog_peer_ref(&self, ids: &[i64]) -> Result<Option<PeerRef>, StorageError> {
        let mut iter = self.client.iter_dialogs();
        while let Some(dialog) = iter.next().await? {
            if ids.contains(&dialog.peer().id().bare_id()) {
                return Ok(Some(dialog.peer_ref()));
            }
        }
        Ok(None)
    }

    /// Resolve a private invite hash to a membership verdict via
    /// `messages.checkChatInvite`. The call is answered from the calling
    /// account's perspective: `ChatInviteAlready` means it has already joined
    /// (member); the `ChatInvite` (preview) and `ChatInvitePeek` (temporary
    /// peek) variants mean it hasn't. An expired/invalid hash is a
    /// misconfiguration — deny (fail closed) with a warning rather than
    /// treating it as a transient error that retries forever.
    async fn check_invite_membership(&self, hash: &str) -> Result<bool, StorageError> {
        match self
            .client
            .invoke(&tl::functions::messages::CheckChatInvite {
                hash: hash.to_string(),
            })
            .await
        {
            Ok(tl::enums::ChatInvite::Already(_)) => Ok(true),
            Ok(_) => Ok(false),
            Err(e) if e.is("INVITE_HASH_EXPIRED") || e.is("INVITE_HASH_INVALID") => {
                log::warn!(
                    target: "tgb-telegram-storage",
                    "access group invite hash is invalid/expired — denying access: {e}"
                );
                Ok(false)
            }
            Err(e) => Err(StorageError::Telegram(format!(
                "checkChatInvite membership probe failed: {e}"
            ))),
        }
    }

    /// Resolve the configured access group to the shared storage
    /// [`PeerRef`] every authorized member reads and writes.
    ///
    /// This is the mechanism behind the **single shared group**: when
    /// `TGB_TELEGRAM_ACCESS_GROUP` is set, every user's uploads /
    /// downloads / deletes target this one group (the same group the login
    /// gate checks membership against) — so all members see one shared
    /// catalog. The group is
    /// created once out-of-band (by whoever owns the invite link); this
    /// code only ever *resolves and reuses* it, never creates one.
    ///
    /// Same three spec shapes as [`Self::probe_membership`], each yielding
    /// the group's addressable peer (id + access-hash):
    ///
    /// - **Private invite link** — `messages.checkChatInvite` returns the
    ///   already-joined chat inline as `ChatInviteAlready { chat }`; the
    ///   peer comes straight off it (no dialog walk needed). Any other
    ///   variant means this account hasn't joined, so there's no peer.
    /// - **Public `@username`** — `resolve_username` → `to_ref` (works
    ///   regardless of membership; posting still requires being a member).
    /// - **Numeric chat id** — found by walking the user's own dialogs (a
    ///   member always has the group there).
    ///
    /// `Ok(None)` means the group couldn't be resolved for this account
    /// (not a member / unusable spec); the caller turns that into a hard
    /// error rather than silently falling back to a per-user chat.
    async fn resolve_access_group_peer(
        &self,
        spec: &str,
    ) -> Result<Option<PeerRef>, StorageError> {
        if let Some(hash) = parse_invite_hash(spec) {
            return self.resolve_invite_peer(hash).await;
        }
        if let Some(uname) = parse_group_username(spec) {
            return Ok(match self.client.resolve_username(uname).await? {
                Some(peer) => peer.to_ref().await,
                None => None,
            });
        }
        if let Some(ids) = parse_group_id_candidates(spec) {
            return self.find_dialog_peer_ref(&ids).await;
        }
        Ok(None)
    }

    /// Resolve a private invite hash to the joined group's [`PeerRef`] via
    /// `messages.checkChatInvite`. `ChatInviteAlready { chat }` carries the
    /// chat the calling account has already joined, so its peer (with the
    /// access-hash) comes straight off it. Any other variant means the
    /// account hasn't joined — no peer to return.
    async fn resolve_invite_peer(&self, hash: &str) -> Result<Option<PeerRef>, StorageError> {
        match self
            .client
            .invoke(&tl::functions::messages::CheckChatInvite {
                hash: hash.to_string(),
            })
            .await
        {
            Ok(tl::enums::ChatInvite::Already(already)) => {
                Ok(Some(PeerRef::from(&already.chat)))
            }
            Ok(_) => Ok(None),
            // Go through `From<InvocationError>` so a signed-out session still
            // surfaces as `NotAuthenticated` (and flood waits as `RateLimited`).
            Err(e) => Err(match StorageError::from(e) {
                StorageError::Telegram(msg) => StorageError::Telegram(format!(
                    "checkChatInvite storage-peer resolution failed: {msg}"
                )),
                other => other,
            }),
        }
    }

    /// True iff the sender pool has bound an authorization key for
    /// the saved DC. Use this to gate the auth flow.
    pub async fn is_authorized(&self) -> Result<bool, StorageError> {
        Ok(self.client.is_authorized().await?)
    }

    /// Resolve the destination chat for every upload / download / delete
    /// into a real `PeerRef` (id + access-hash): the ONE shared group named
    /// by `TGB_TELEGRAM_ACCESS_GROUP`, resolved via
    /// [`Self::resolve_access_group_peer`] from the same spec the login gate
    /// checks. There is no fallback — no per-user group is ever created and
    /// Saved Messages is never used. If the variable is unset, or the group
    /// can't be resolved (the account isn't a member, or the spec is
    /// unusable), this returns an error.
    ///
    /// Cached for the lifetime of this `ConnectedClient` so the resolution
    /// round-trip happens at most once per session.
    pub async fn target_peer(&self) -> Result<PeerRef, StorageError> {
        let peer = self
            .target_peer
            .get_or_try_init(|| async {
                let spec = self.access_group.as_deref().ok_or_else(|| {
                    StorageError::Internal(
                        "TGB_TELEGRAM_ACCESS_GROUP is not set — it names the Telegram group \
                         used as storage"
                            .into(),
                    )
                })?;
                match self.resolve_access_group_peer(spec).await? {
                    Some(peer) => {
                        log::info!(
                            target: "tgb-telegram-storage",
                            "storing into the shared access group (TGB_TELEGRAM_ACCESS_GROUP={spec:?})"
                        );
                        Ok(peer)
                    }
                    None => Err(StorageError::Internal(format!(
                        "shared access group {spec:?} could not be resolved to a storage peer \
                         (is this account a member?)"
                    ))),
                }
            })
            .await?;
        Ok(*peer)
    }

    /// Walk the destination chat's message history once and insert a
    /// `tg_files` row for every document attachment that doesn't already
    /// have one (matched by `tg_message_id`). Idempotent — re-running it
    /// is a no-op for rows that already exist. Gated by an internal
    /// `OnceCell` so the actual walk runs at most once per
    /// `ConnectedClient` lifetime; subsequent callers return immediately.
    ///
    /// This is what prevents double-uploads of the same file across
    /// devices: without it, the local `find_by_name` dedup only sees
    /// what *this* SQLite has written, so a re-install (or a second
    /// device) would silently re-upload every file the user already has
    /// on Telegram.
    ///
    /// **Multipart-aware.** Documents whose caption parses as a
    /// `tgb-multipart` marker are buffered by `groupId` during the
    /// walk; once every chunk for a group has been seen we mint one
    /// `tg_files` row + N `tg_file_part` rows together so the download
    /// path can reassemble the bytes. Partial multipart groups (a
    /// crashed upload, or a sweep that catches an in-flight one mid-
    /// stream) are skipped and retried on the next session — orphan
    /// chunks stay on Telegram until manually pruned.
    pub async fn reconcile_chat_index(&self, db: &crate::pool::Db) -> Result<usize, StorageError> {
        // OnceCell::get_or_try_init runs the closure at most once. If it
        // fails the cell stays empty so the next caller can retry.
        let mut outcome = WalkOutcome::default();
        self.index_reconciled
            .get_or_try_init(|| async {
                outcome = self
                    .walk_and_mint(db, &ReconcileFilter::All, &mut None, None)
                    .await?;
                Ok::<(), StorageError>(())
            })
            .await?;
        Ok(outcome.inserted_total)
    }

    /// Walk the chat once and recover the connector/chain catalog graph:
    /// the `*-metadata` reply messages (which never enter `tg_files`) plus
    /// the reply-to edge for every uploaded media file's head chunk. The
    /// media files themselves are minted into `tg_files` during the same
    /// walk (so the player can stream them), exactly as
    /// [`Self::reconcile_chat_index`] would — the walk runs the `All`
    /// filter. Unlike the reconcile helpers this is **not** `OnceCell`-
    /// gated: the catalog caches the assembled tree itself and only re-
    /// walks on an explicit refresh, and the minting stays idempotent
    /// (already-indexed chunks are skipped) so re-walking is cheap on the
    /// DB side.
    pub async fn scan_chain_catalog(
        &self,
        db: &crate::pool::Db,
    ) -> Result<ChainCatalogScan, StorageError> {
        let (scan, _) = self.scan_chain_catalog_since(db, None).await?;
        Ok(scan)
    }

    /// Incremental variant of [`Self::scan_chain_catalog`]. When `since`
    /// is `Some(id)` the walk only processes messages newer than `id`
    /// (the previous high-water mark), so the catalog endpoint can pick
    /// up newly-completed chains without re-walking the whole chat.
    /// Returns the scan of those new messages plus the id of the newest
    /// message seen (`None` for an empty chat) — the caller merges the
    /// new graph into its accumulator and adopts the new id as the next
    /// high-water mark. `since == None` is a full walk (the basis for
    /// [`Self::scan_chain_catalog`]).
    pub async fn scan_chain_catalog_since(
        &self,
        db: &crate::pool::Db,
        since: Option<i64>,
    ) -> Result<(ChainCatalogScan, Option<i64>), StorageError> {
        let mut scan = Some(ChainCatalogScan::default());
        let outcome = self
            .walk_and_mint(db, &ReconcileFilter::All, &mut scan, since)
            .await?;
        Ok((scan.unwrap_or_default(), outcome.newest_message_id))
    }

    /// The id of the most recent message on the chat (`None` when the
    /// chat is empty). A cheap single-message `getHistory` — the catalog
    /// poll compares it against its high-water mark to decide whether a
    /// (bounded) re-walk is needed at all.
    pub async fn latest_message_id(&self) -> Result<Option<i64>, StorageError> {
        let target = self.target_peer().await?;
        let mut iter = self.client.iter_messages(target).limit(1);
        Ok(iter.next().await?.map(|m| m.id() as i64))
    }

    /// Download an arbitrary chat message's media into memory, bounded to
    /// `max` bytes. Used by the catalog scan to read the oversized
    /// `*-metadata` JSON documents that ride as plain attachments (no
    /// `tg_files` row to `download_to_bytes` against).
    async fn download_media_bytes(
        &self,
        media: &grammers_client::media::Media,
        max: usize,
    ) -> Result<Vec<u8>, StorageError> {
        let mut iter = self.client.iter_download(media);
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = iter.next().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() >= max {
                break;
            }
        }
        Ok(buf)
    }

    /// Fast-path walk used by the catalog scan: walks the chat once,
    /// only minting multipart groups whose marker metadata has
    /// `role == "metadata"`. Media chunks (every chunk of a `role:
    /// "media"` upload) are skipped entirely — no buffering, no DB
    /// writes — so the catalog can land its list without paying the
    /// per-chunk cost. Gated by [`Self::metadata_index_reconciled`] so
    /// repeated catalog refreshes within one session don't re-walk the
    /// chat; the local SQLite already carries the metadata rows.
    pub async fn reconcile_chat_metadata_only(
        &self,
        db: &crate::pool::Db,
    ) -> Result<usize, StorageError> {
        let mut outcome = WalkOutcome::default();
        self.metadata_index_reconciled
            .get_or_try_init(|| async {
                outcome = self
                    .walk_and_mint(db, &ReconcileFilter::MetadataOnly, &mut None, None)
                    .await?;
                Ok::<(), StorageError>(())
            })
            .await?;
        Ok(outcome.inserted_total)
    }

    /// On-demand walk used when the user hits play on a catalog row:
    /// walks the chat once and mints the multipart group whose marker
    /// metadata has the matching `pipelineId` AND `role != "metadata"`.
    /// Other chunks (other pipelines' media, the metadata sidecars) are
    /// skipped entirely. Not cached by a `OnceCell` — caller is expected
    /// to first check the DB via [`crate::db::find_media_by_pipeline_id`]
    /// so the walk only runs when the row genuinely hasn't been minted
    /// yet. Returns the minted file id (when a complete group was
    /// found) or `None` (no matching media in the chat / the group is
    /// still incomplete).
    pub async fn reconcile_chat_media_for_pipeline(
        &self,
        db: &crate::pool::Db,
        pipeline_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let outcome = self
            .walk_and_mint(
                db,
                &ReconcileFilter::MediaForPipeline(pipeline_id),
                &mut None,
                None,
            )
            .await?;
        Ok(outcome.minted_file_ids.into_iter().next())
    }

    /// Shared walking + minting body. The `filter` decides which chat
    /// messages contribute to the `tg_files` index; the walk itself is
    /// always full-chat because Telegram doesn't let us filter messages
    /// by caption content server-side.
    ///
    /// `since` bounds an **incremental** walk: when `Some(id)`, the walk
    /// stops as soon as it reaches a message whose id is `<= id` (already
    /// scanned on a previous pass), so only messages newer than the
    /// high-water mark are processed. `None` walks the whole chat.
    async fn walk_and_mint(
        &self,
        db: &crate::pool::Db,
        filter: &ReconcileFilter<'_>,
        scan: &mut Option<ChainCatalogScan>,
        since: Option<i64>,
    ) -> Result<WalkOutcome, StorageError> {
        let target = self.target_peer().await?;
        log::info!(
            target: "tgb-telegram-storage",
            "reconciling chat → tg_files index for peer {chat_id:?} ({filter:?})",
            chat_id = target.id,
        );

        use grammers_client::media::Media;
        use std::collections::HashMap;

        let mut outcome = WalkOutcome::default();
        // Multipart chunks seen so far, keyed by groupId. Each entry
        // tracks the chunks we've discovered plus the declared total so
        // we can mint once all parts are in. For the catalog scan (`All`),
        // seed it with what earlier walks already staged in
        // `tg_pending_part` so chunks a single walk can't see all at once
        // accumulate until the group is complete (see `uses_staging`).
        let mut multipart_groups: HashMap<String, MultipartGroup> = HashMap::new();
        if filter.uses_staging() {
            for pc in crate::db::load_pending_chunks(db).await? {
                let group = multipart_groups
                    .entry(multipart_group_key(
                        &pc.name,
                        pc.declared_size as u64,
                        pc.total as u64,
                    ))
                    .or_insert_with(|| MultipartGroup {
                        total: pc.total as u64,
                        name: pc.name.clone(),
                        size: pc.declared_size as u64,
                        mime: pc.mime.clone(),
                        caption: pc.caption.clone(),
                        checksum: pc.checksum.clone(),
                        metadata: pc
                            .metadata
                            .as_deref()
                            .and_then(|s| serde_json::from_str(s).ok()),
                        chunks: Vec::new(),
                    });
                group
                    .chunks
                    .push((pc.ord as u64, pc.tg_message_id, pc.size_bytes, pc.part_checksum));
            }
        }

        let mut iter = self.client.iter_messages(target);
        while let Some(msg) = iter.next().await? {
            let msg_id = msg.id() as i64;
            // `iter_messages` yields newest→oldest, so the first message
            // is the newest — record it as the high-water mark for the
            // incremental scan.
            if outcome.newest_message_id.is_none() {
                outcome.newest_message_id = Some(msg_id);
            }
            // Incremental bound: stop once we reach a message already
            // covered by a previous walk.
            if let Some(s) = since {
                if msg_id <= s {
                    break;
                }
            }
            // Chain-catalog scan (only when a sink is supplied). The
            // connector/chain posters write the `*-metadata` rows as
            // native replies — plain text, a photo caption, or a JSON
            // document — that carry no `tgb-multipart` marker, so they
            // never land in `tg_files`. Capture them here (with each
            // message's reply-to id) so the catalog can rethread the
            // movies / albums they describe. Small payloads ride as the
            // message text / caption and are parsed inline; oversized ones
            // ride as a `.json` document and are downloaded below.
            if scan.is_some() {
                if let Some((role, payload)) = parse_chain_meta(msg.text()) {
                    if let Some(s) = scan.as_mut() {
                        s.metadata_messages.push(ChainMetaMessage {
                            message_id: msg.id() as i64,
                            reply_to_message_id: msg.reply_to_message_id().map(|v| v as i64),
                            role,
                            payload,
                        });
                    }
                    continue;
                }
            }

            let Some(media) = msg.media() else { continue };
            let Media::Document(doc) = media else {
                continue;
            };
            let Some(name) = doc.name() else { continue };
            if name.is_empty() {
                continue;
            }
            let name: String = name.to_string();
            let tg_message_id = msg.id() as i64;
            let size_bytes = doc.size().unwrap_or(0) as i64;
            let mime_type = doc.mime_type().unwrap_or("application/octet-stream");
            // Mirror the message caption back into `tg_files.text` so a
            // fresh device signing in to the same Telegram account can
            // rebuild its firkin collection from the `tgb-firkin`
            // JSON marker the catalog detail page stamps on every
            // torrent upload. Plain uploads (the /telegram page's drag-
            // and-drop, album-track uploads) carry no caption; the
            // column stays NULL for those.
            let raw_text = msg.text();

            // Multipart? Buffer and keep walking — we mint the group
            // once every chunk lands.
            if let Some(part) = parse_multipart_marker(raw_text) {
                // Record the file's head (chunk-0) message and its reply-to
                // edge, so the catalog can spot a file this walk saw but
                // never minted (see `MediaLink`).
                if scan.is_some() && part.index == 0 {
                    if let Some(s) = scan.as_mut() {
                        s.media_links.push(MediaLink {
                            head_message_id: tg_message_id,
                            reply_to_message_id: msg.reply_to_message_id().map(|v| v as i64),
                        });
                    }
                }
                if !filter.keep_multipart(&part) {
                    continue;
                }
                // NB: we deliberately do NOT skip a chunk just because a
                // `tg_file_part` row already exists for its message id. That
                // skip used to strand a file forever once a partial /
                // interrupted mint left stale part rows behind — the chunk
                // would be hidden on every future walk, so the group could
                // never re-complete. Instead we always collect the chunk and
                // let `heal_and_mint_multipart` reconcile against the DB
                // (leaving an already-healthy file untouched, re-minting a
                // broken one).
                let group = multipart_groups
                    .entry(multipart_group_key(&part.name, part.size, part.total))
                    .or_insert_with(|| MultipartGroup {
                        total: part.total,
                        name: part.name.clone(),
                        size: part.size,
                        mime: part.mime.clone(),
                        caption: part.caption.clone(),
                        checksum: part.checksum.clone(),
                        metadata: part.metadata.clone(),
                        chunks: Vec::new(),
                    });
                // Later chunks of a v2 upload may carry the checksum /
                // metadata even if the first chunk we sweep does not
                // (the walker order isn't guaranteed to be `index=0`
                // first). Fill the group as soon as any chunk supplies
                // them.
                if group.checksum.is_none() && part.checksum.is_some() {
                    group.checksum = part.checksum.clone();
                }
                if group.metadata.is_none() && part.metadata.is_some() {
                    group.metadata = part.metadata.clone();
                }
                // Dedup by chunk index — the group may already carry this
                // chunk from a staging seed or an earlier sighting this walk.
                if !group.chunks.iter().any(|c| c.0 == part.index) {
                    group.chunks.push((
                        part.index,
                        tg_message_id,
                        size_bytes,
                        part.part_checksum.clone(),
                    ));
                }
                continue;
            }

            // Oversized `*-metadata` payloads (a full TMDB show / movie
            // JSON over Telegram's text limit) ride as a `.json` document
            // with a short human caption — no multipart marker, so the
            // inline text parse above missed them. Download + parse them
            // here when scanning. Bounded so a stray large `.json` can't
            // blow up memory.
            if scan.is_some() && name.ends_with(".json") && (size_bytes as usize) <= MAX_SCAN_META_BYTES {
                if let Ok(bytes) = self
                    .download_media_bytes(&Media::Document(doc.clone()), MAX_SCAN_META_BYTES)
                    .await
                {
                    if let Some((role, payload)) = bytes_to_chain_meta(&bytes) {
                        if let Some(s) = scan.as_mut() {
                            s.metadata_messages.push(ChainMetaMessage {
                                message_id: tg_message_id,
                                reply_to_message_id: msg.reply_to_message_id().map(|v| v as i64),
                                role,
                                payload,
                            });
                        }
                    }
                }
            }

            // Unmarked documents count only when they are zips, so other
            // messages in the group don't show up as backups.
            if !filter.keep_legacy_doc() || !crate::media_type::is_allowed(&name, mime_type) {
                continue;
            }

            let text_opt: Option<&str> = if raw_text.is_empty() {
                None
            } else {
                Some(raw_text)
            };

            // Skip if we already have a row for this message id —
            // either as a head row (legacy single-message) or as a
            // chunk in an existing multipart file.
            if crate::db::find_by_tg_message_id(db, tg_message_id)
                .await?
                .is_some()
            {
                continue;
            }
            if crate::db::part_message_id_exists(db, tg_message_id).await? {
                continue;
            }

            let id = uuid::Uuid::new_v4().to_string();
            crate::db::insert(
                db,
                &id,
                &name,
                size_bytes,
                mime_type,
                tg_message_id,
                text_opt,
                None,
                None,
            )
            .await?;
            crate::db::insert_part(db, &id, 0, tg_message_id, size_bytes, None).await?;
            outcome.inserted_total += 1;
            outcome.minted_file_ids.push(id);
        }

        // Reconcile every multipart group we accumulated (this walk plus
        // any staged from earlier walks). A complete group is minted /
        // healed; an incomplete one (some chunks still unseen) is persisted
        // back to `tg_pending_part` so the next walk can finish it.
        for (group_id, group) in multipart_groups {
            let mut chunks = group.chunks;
            chunks.sort_by_key(|c| c.0);

            let metadata_string: Option<String> = match group.metadata.as_ref() {
                Some(v) => serde_json::to_string(v).ok(),
                None => None,
            };

            let complete = chunks.len() as u64 == group.total
                && chunks.iter().enumerate().all(|(i, c)| c.0 as usize == i);

            if !complete {
                log::debug!(
                    target: "tgb-telegram-storage",
                    "multipart group {group_id}: have {} / {} chunks — staged for a later walk",
                    chunks.len(),
                    group.total,
                );
                // Accumulate what we've seen so a straddling / interrupted
                // file eventually completes across walks (catalog scan only).
                if filter.uses_staging() {
                    for (ord, msg_id, size, part_checksum) in &chunks {
                        crate::db::upsert_pending_part(
                            db,
                            &group_id,
                            *ord as i64,
                            *msg_id,
                            *size,
                            part_checksum.as_deref(),
                            group.total as i64,
                            &group.name,
                            group.size as i64,
                            &group.mime,
                            group.caption.as_deref(),
                            group.checksum.as_deref(),
                            metadata_string.as_deref(),
                        )
                        .await?;
                    }
                }
                continue;
            }

            let total_size = chunks.iter().map(|c| c.2).sum::<i64>();
            // Trust the marker's declared `size` only when it matches
            // the sum of chunk sizes — otherwise the sum is the safer
            // source of truth (covers a marker that got rewritten mid-
            // upload).
            let declared_size = group.size as i64;
            let final_size = if declared_size > 0 && declared_size == total_size {
                declared_size
            } else {
                total_size
            };
            let mint_chunks: Vec<(i64, i64, i64, Option<String>)> = chunks
                .iter()
                .map(|(ord, msg_id, size, part_checksum)| {
                    (*ord as i64, *msg_id, *size, part_checksum.clone())
                })
                .collect();
            let mint = crate::db::MintGroup {
                name: &group.name,
                final_size,
                mime: &group.mime,
                caption: group.caption.as_deref(),
                checksum: group.checksum.as_deref(),
                metadata: metadata_string.as_deref(),
                chunks: &mint_chunks,
            };
            if let Some(id) = crate::db::heal_and_mint_multipart(db, &mint).await? {
                outcome.inserted_total += 1;
                outcome.minted_file_ids.push(id);
            }
            // Whether freshly minted or already healthy, this group no
            // longer needs staging. Delete by the file's stable identity, not
            // just `group_id`, so any fragments an interrupted-then-resumed
            // upload left under a *different* marker `groupId` are cleared too.
            if filter.uses_staging() {
                crate::db::delete_pending_group_by_identity(
                    db,
                    &group.name,
                    group.size as i64,
                    group.total as i64,
                )
                .await?;
            }
        }

        log::info!(
            target: "tgb-telegram-storage",
            "chat reconcile finished — inserted {n} new tg_files row(s)",
            n = outcome.inserted_total,
        );
        Ok(outcome)
    }

    /// Cleanly stop the sender pool. Idempotent — repeated calls after
    /// the runner has been joined are no-ops. Takes `&self` so callers
    /// holding an `Arc<ConnectedClient>` (e.g. an in-flight upload) can
    /// trigger shutdown without owning the value uniquely.
    pub async fn shutdown(&self) {
        self.pool_handle.quit();
        if let Some(task) = self.runner_task.lock().await.take() {
            let _ = task.await;
        }
        if let Some(pool) = self.upload_pool.get() {
            for extra in &pool.extras {
                extra.pool_handle.quit();
                if let Some(task) = extra.runner.lock().await.take() {
                    let _ = task.await;
                }
            }
        }
    }
}

/// Read the optional access-control group identity from the environment.
///
/// `TGB_TELEGRAM_ACCESS_GROUP` may hold a private invite link
/// (`https://t.me/+<hash>`, `joinchat/<hash>`, or a bare `+<hash>`), a public
/// `@username` (or bare `username`), or a numeric chat id — either the `-100…`
/// supergroup form or the bare id. Blank / unset disables membership gating
/// (any signed-in account may use the app). Read here (rather than threaded
/// through `TelegramConfig`) to mirror the existing `credentials_from_env`
/// precedent and stay zero-churn across the crate's many config construction
/// sites.
fn access_group_from_env() -> Option<String> {
    std::env::var("TGB_TELEGRAM_ACCESS_GROUP")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Whether this deployment gates login on Telegram group membership
/// (`TGB_TELEGRAM_ACCESS_GROUP` is set to a non-empty spec). A
/// deployment-level constant — read from the env so `GET /status` can
/// advertise the requirement to the UI even before any client has connected
/// (so the login screen can tell users up front that group membership is
/// required, and non-members can't slip past). When this is `false`, any
/// signed-in account is authorized and uploads fall back to a per-user chat.
pub fn access_group_configured() -> bool {
    access_group_from_env().is_some()
}

/// A shareable `https://t.me/…` URL for the configured access group, so the UI
/// can render a "join this group" link + QR code for non-members. Derived from
/// the same `TGB_TELEGRAM_ACCESS_GROUP` spec the login gate uses:
///
/// - a private invite (`t.me/+<hash>` / `joinchat/<hash>` / bare `+<hash>`) →
///   `https://t.me/+<hash>` (canonicalised),
/// - a public `@username` (or bare username) → `https://t.me/<username>`,
/// - a numeric chat id → `None` (a bare id has no shareable public link).
///
/// Returns `None` when gating is disabled.
pub fn access_group_invite_url() -> Option<String> {
    let spec = access_group_from_env()?;
    if let Some(hash) = parse_invite_hash(&spec) {
        return Some(format!("https://t.me/+{hash}"));
    }
    if parse_group_id_candidates(&spec).is_some() {
        return None;
    }
    parse_group_username(&spec).map(|u| format!("https://t.me/{u}"))
}

/// Extract the invite hash from a private group link. Accepts the modern
/// `t.me/+<hash>` form, the legacy `t.me/joinchat/<hash>` form (each with or
/// without an `https://` / `http://` scheme), and a bare `+<hash>`. Returns
/// `None` for anything else (a public `@username` or a numeric id), so the
/// caller falls through to the username / id paths.
fn parse_invite_hash(spec: &str) -> Option<&str> {
    let s = spec.trim();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let s = s
        .strip_prefix("t.me/")
        .or_else(|| s.strip_prefix("telegram.me/"))
        .unwrap_or(s);
    if let Some(rest) = s.strip_prefix('+') {
        return (!rest.is_empty()).then_some(rest);
    }
    if let Some(rest) = s.strip_prefix("joinchat/") {
        return (!rest.is_empty()).then_some(rest);
    }
    None
}

/// Interpret an access-group spec as a public username, returning the bare
/// username (without a leading `@`). Returns `None` when the spec is a numeric
/// chat id — Telegram usernames must start with a letter, so a purely-numeric
/// (optionally `-`-prefixed) spec is unambiguously an id, handled by
/// [`parse_group_id_candidates`].
fn parse_group_username(spec: &str) -> Option<&str> {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix('@') {
        return (!rest.is_empty()).then_some(rest);
    }
    let looks_numeric =
        !spec.is_empty() && spec.trim_start_matches('-').chars().all(|c| c.is_ascii_digit());
    (!looks_numeric).then_some(spec)
}

/// Interpret an access-group spec as a numeric chat id, yielding the candidate
/// bare ids to match against `Peer::id().bare_id()`. The `-100…`
/// supergroup/channel form carries a `100` prefix the bare id drops, so both
/// the de-prefixed value and the plain parse are returned — whichever Telegram
/// stamps on the dialog peer will match. Returns `None` for non-numeric specs.
fn parse_group_id_candidates(spec: &str) -> Option<Vec<i64>> {
    let digits = spec.trim().trim_start_matches('-');
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut candidates = Vec::new();
    if let Ok(n) = digits.parse::<i64>() {
        candidates.push(n);
    }
    if let Some(rest) = digits.strip_prefix("100") {
        if let Ok(bare) = rest.parse::<i64>() {
            if !candidates.contains(&bare) {
                candidates.push(bare);
            }
        }
    }
    (!candidates.is_empty()).then_some(candidates)
}

/// Filter applied during a chat walk to decide which uploads to mint
/// into the local `tg_files` index. The filter does not change how the
/// walk iterates Telegram messages — that's always full-chat — only
/// which documents we insert into SQLite.
#[derive(Debug)]
enum ReconcileFilter<'a> {
    /// Mint every document: legacy single-message uploads + every
    /// multipart group whose chunks are all present.
    All,
    /// Skip legacy single-message uploads. For multipart groups, mint
    /// only those whose marker metadata has `role == "metadata"`. Backs
    /// the fast catalog scan so we don't touch SQLite for media chunks.
    MetadataOnly,
    /// Skip legacy single-message uploads. For multipart groups, mint
    /// only those whose marker metadata has `pipelineId == <pid>` AND
    /// `role != "metadata"`. Backs the on-demand media load when the
    /// user hits play on a catalog row.
    MediaForPipeline(&'a str),
}

impl ReconcileFilter<'_> {
    fn keep_legacy_doc(&self) -> bool {
        matches!(self, ReconcileFilter::All)
    }

    fn keep_multipart(&self, chunk: &MultipartChunk) -> bool {
        match self {
            ReconcileFilter::All => true,
            ReconcileFilter::MetadataOnly => marker_role(chunk) == Some("metadata"),
            ReconcileFilter::MediaForPipeline(pid) => {
                marker_pipeline_id(chunk) == Some(*pid)
                    && marker_role(chunk) != Some("metadata")
            }
        }
    }

    /// Whether this walk should persist partial multipart observations to
    /// `tg_pending_part` (seeding from it at the start and staging any group
    /// still incomplete at the end) so a file whose chunks can't be seen in
    /// one pass accumulates across walks. Only the full `All` reconcile (the
    /// catalog scan) does this — the targeted `MediaForPipeline` / metadata
    /// walks stay single-pass.
    fn uses_staging(&self) -> bool {
        matches!(self, ReconcileFilter::All)
    }
}

fn marker_role(chunk: &MultipartChunk) -> Option<&str> {
    chunk.metadata.as_ref()?.get("role")?.as_str()
}

fn marker_pipeline_id(chunk: &MultipartChunk) -> Option<&str> {
    chunk.metadata.as_ref()?.get("pipelineId")?.as_str()
}

/// Roles carried by the connector/chain `*-metadata` reply messages the
/// catalog rethreads into movies / albums, the `tv-episode-metadata`
/// replies a TV season acquisition publishes per episode, plus the
/// `movie-request` / `tv-request` marker messages the SPA posts so a wanted
/// title can be reconstructed (by its embedded TMDB id) on every signed-in
/// device. Everything else the scan walk encounters is ignored.
const CHAIN_META_ROLES: [&str; 5] = [
    "movie-metadata",
    "album-metadata",
    "movie-request",
    "tv-request",
    "tv-episode-metadata",
];

/// Cap on a single `*-metadata` document download during a scan walk.
const MAX_SCAN_META_BYTES: usize = 512 * 1024;

/// One `*-metadata` reply message recovered from a chat scan. The
/// connector/chain posters send these as native replies (plain text, a
/// photo caption, or a JSON document) that carry no multipart marker, so
/// they never land in `tg_files`. [`ConnectedClient::scan_chain_catalog`]
/// reads them straight off the chat; the backend catalog rethreads movies
/// through their embedded `link.masterMessageId` and albums through their
/// `connectorRunId`.
#[derive(Debug, Clone)]
pub struct ChainMetaMessage {
    /// This metadata message's own Telegram message id.
    pub message_id: i64,
    /// The message it replied to (`None` for a root message).
    pub reply_to_message_id: Option<i64>,
    /// One of [`CHAIN_META_ROLES`].
    pub role: String,
    /// The decoded JSON payload (the full `{ role, … }` object).
    pub payload: serde_json::Value,
}

/// Links a multipart media file's head (chunk-0) message to the message
/// it replied to. The catalog uses the recorded heads to detect media a
/// bounded walk saw but never minted (a stranded file).
#[derive(Debug, Clone)]
pub struct MediaLink {
    /// Equal to the file's `tg_files.tg_message_id`.
    pub head_message_id: i64,
    /// The message the head chunk replied to, if any.
    pub reply_to_message_id: Option<i64>,
}

/// Result of a single chain-catalog chat walk.
#[derive(Debug, Default, Clone)]
pub struct ChainCatalogScan {
    pub metadata_messages: Vec<ChainMetaMessage>,
    pub media_links: Vec<MediaLink>,
}

/// Parse a message's text / caption as a recognised `*-metadata` payload.
fn parse_chain_meta(text: &str) -> Option<(String, serde_json::Value)> {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    chain_meta_role(&value).map(|role| (role, value))
}

/// Same as [`parse_chain_meta`] but for a downloaded JSON document body.
fn bytes_to_chain_meta(bytes: &[u8]) -> Option<(String, serde_json::Value)> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    chain_meta_role(&value).map(|role| (role, value))
}

fn chain_meta_role(value: &serde_json::Value) -> Option<String> {
    let role = value.get("role").and_then(|v| v.as_str())?;
    if CHAIN_META_ROLES.contains(&role) {
        Some(role.to_string())
    } else {
        None
    }
}

/// Outcome of a single [`ConnectedClient::walk_and_mint`] pass.
#[derive(Default)]
struct WalkOutcome {
    inserted_total: usize,
    /// File ids of the `tg_files` rows minted by this walk, in the
    /// order they were inserted. Empty when nothing matched the
    /// filter. The per-pipeline media reconcile reads the first
    /// element to return the freshly-minted media file id.
    minted_file_ids: Vec<String>,
    /// The id of the newest message the walk saw (the first one, since
    /// `iter_messages` yields newest→oldest). `None` when the chat is
    /// empty. Used by the incremental catalog scan as the new
    /// high-water mark.
    newest_message_id: Option<i64>,
}

/// Stable identity for a multipart logical file during reconstruction,
/// independent of the marker's `groupId`. The `groupId` is minted fresh on
/// every upload *attempt* ([`crate::upload`]), so an interrupted-then-resumed
/// upload tags its chunks with *different* `groupId`s even though they belong
/// to one file — e.g. Mulan's 27 chunks split as chunk 0 / 1–4 / 5–26 across
/// three attempts. Keying the reconcile walk (and its `tg_pending_part`
/// staging) on `(name, declared_size, total)` re-fuses those fragments so the
/// file mints once every chunk is present, instead of stranding as several
/// perpetually-incomplete groups. This is the same `(name, size)` identity
/// [`crate::upload`]'s resume path already treats as one logical file.
fn multipart_group_key(name: &str, declared_size: u64, total: u64) -> String {
    format!("{name}\u{0}{declared_size}\u{0}{total}")
}

/// Parsed `tgb-multipart` marker. See [`crate::upload`] for the wire
/// format; this struct accepts both v1 (caption-only) and v2 (with
/// `checksum`, `partChecksum`, `metadata`) markers.
#[derive(Debug)]
struct MultipartChunk {
    index: u64,
    total: u64,
    name: String,
    size: u64,
    mime: String,
    caption: Option<String>,
    /// Full-file SHA-256 hex. `None` for v1 markers.
    checksum: Option<String>,
    /// This chunk's SHA-256 hex. `None` for v1 markers.
    part_checksum: Option<String>,
    /// Caller-supplied JSON metadata mirrored verbatim. `None` for v1
    /// markers and for v2 uploads that didn't carry metadata.
    metadata: Option<serde_json::Value>,
}

/// Aggregator used during the reconcile walk. We collect every chunk
/// for a group as we encounter it, then mint a single `tg_files` row
/// at the end of the walk once we've verified all `total` chunks are
/// present. `caption` carries the caller's original `text`
/// (e.g. the `tgb-firkin` marker the catalog detail page stamps) so
/// the existing `tg_files.text`-driven reconcile flows pick it up
/// uniformly on single- and multi-part files.
struct MultipartGroup {
    total: u64,
    name: String,
    size: u64,
    mime: String,
    caption: Option<String>,
    checksum: Option<String>,
    metadata: Option<serde_json::Value>,
    /// `(chunk_index, tg_message_id, size_bytes, part_checksum)` per chunk.
    chunks: Vec<(u64, i64, i64, Option<String>)>,
}

fn parse_multipart_marker(raw_text: &str) -> Option<MultipartChunk> {
    let trimmed = raw_text.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if value.get("kind").and_then(|v| v.as_str()) != Some("tgb-multipart") {
        return None;
    }
    let version = value.get("v").and_then(|v| v.as_u64())?;
    if version != 1 && version != 2 {
        return None;
    }
    // A well-formed marker always carries a `groupId`; require it as a
    // validity check even though reconstruction now keys on
    // `(name, size, total)` rather than this (per-attempt, unstable) id.
    value.get("groupId")?.as_str()?;
    let index = value.get("index")?.as_u64()?;
    let total = value.get("total")?.as_u64()?;
    let name = value.get("name")?.as_str()?.to_string();
    let size = value.get("size")?.as_u64()?;
    let mime = value
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    let caption = value
        .get("caption")
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let checksum = value
        .get("checksum")
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let part_checksum = value
        .get("partChecksum")
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let metadata = value.get("metadata").cloned().filter(|v| !v.is_null());
    Some(MultipartChunk {
        index,
        total,
        name,
        size,
        mime,
        caption,
        checksum,
        part_checksum,
        metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_key_fuses_fragments_and_separates_distinct_files() {
        // The three Mulan upload attempts carried different marker groupIds
        // but one (name, declared_size, total) — the key must collapse them.
        let a = multipart_group_key("Mulan", 1_392_198_638, 27);
        let b = multipart_group_key("Mulan", 1_392_198_638, 27);
        assert_eq!(a, b, "same logical file → same key regardless of groupId");

        // A different title, a re-transcode (different size), or a different
        // chunk count must NOT collide.
        assert_ne!(a, multipart_group_key("Mulan 2", 1_392_198_638, 27));
        assert_ne!(a, multipart_group_key("Mulan", 1_392_198_639, 27));
        assert_ne!(a, multipart_group_key("Mulan", 1_392_198_638, 28));
    }

    #[test]
    fn multipart_marker_parses_full_payload() {
        let raw = r#"{"v":1,"kind":"tgb-multipart","groupId":"g1","index":3,"total":5,"name":"x.mkv","size":5368709120,"mime":"video/x-matroska","caption":"hello"}"#;
        let parsed = parse_multipart_marker(raw).expect("valid marker");
        assert_eq!(parsed.index, 3);
        assert_eq!(parsed.total, 5);
        assert_eq!(parsed.name, "x.mkv");
        assert_eq!(parsed.size, 5_368_709_120);
        assert_eq!(parsed.mime, "video/x-matroska");
        assert_eq!(parsed.caption.as_deref(), Some("hello"));
    }

    #[test]
    fn multipart_marker_parses_null_caption() {
        let raw = r#"{"v":1,"kind":"tgb-multipart","groupId":"g","index":0,"total":1,"name":"x","size":1,"mime":"a/b","caption":null}"#;
        let parsed = parse_multipart_marker(raw).expect("valid marker");
        assert!(parsed.caption.is_none());
    }

    #[test]
    fn multipart_marker_rejects_wrong_kind() {
        let raw = r#"{"v":1,"kind":"tgb-firkin","groupId":"g","index":0,"total":1,"name":"x","size":1,"mime":"a/b"}"#;
        assert!(parse_multipart_marker(raw).is_none());
    }

    /// v1 (legacy) and v2 (current) are both accepted. Anything else is rejected.
    #[test]
    fn multipart_marker_accepts_v1_and_v2() {
        let v1 = r#"{"v":1,"kind":"tgb-multipart","groupId":"g","index":0,"total":1,"name":"x","size":1,"mime":"a/b","caption":null}"#;
        assert!(parse_multipart_marker(v1).is_some());
        let v2 = r#"{"v":2,"kind":"tgb-multipart","groupId":"g","index":0,"total":1,"name":"x","size":1,"mime":"a/b","caption":null,"checksum":null,"partChecksum":"0","metadata":null}"#;
        assert!(parse_multipart_marker(v2).is_some());
    }

    #[test]
    fn multipart_marker_rejects_unknown_version() {
        let raw = r#"{"v":99,"kind":"tgb-multipart","groupId":"g","index":0,"total":1,"name":"x","size":1,"mime":"a/b"}"#;
        assert!(parse_multipart_marker(raw).is_none());
    }

    #[test]
    fn multipart_marker_v2_carries_checksum_and_metadata() {
        let raw = r#"{"v":2,"kind":"tgb-multipart","groupId":"g1","index":0,"total":2,"name":"x.bin","size":1048576,"mime":"application/octet-stream","caption":"hi","checksum":"abc","partChecksum":"def","metadata":{"firkinId":"fk-1","tags":["a"]}}"#;
        let parsed = parse_multipart_marker(raw).expect("valid v2 marker");
        assert_eq!(parsed.checksum.as_deref(), Some("abc"));
        assert_eq!(parsed.part_checksum.as_deref(), Some("def"));
        let m = parsed.metadata.expect("metadata present");
        assert_eq!(m["firkinId"], "fk-1");
        assert_eq!(m["tags"][0], "a");
    }

    #[test]
    fn multipart_marker_rejects_non_json() {
        assert!(parse_multipart_marker("plain caption").is_none());
        assert!(parse_multipart_marker("").is_none());
    }

    #[test]
    fn invite_hash_parsing() {
        let h = "hAJfgmURLbxhYzM0";
        assert_eq!(parse_invite_hash("https://t.me/+hAJfgmURLbxhYzM0"), Some(h));
        assert_eq!(parse_invite_hash("http://t.me/+hAJfgmURLbxhYzM0"), Some(h));
        assert_eq!(parse_invite_hash("t.me/+hAJfgmURLbxhYzM0"), Some(h));
        assert_eq!(parse_invite_hash("+hAJfgmURLbxhYzM0"), Some(h));
        assert_eq!(
            parse_invite_hash("https://t.me/joinchat/hAJfgmURLbxhYzM0"),
            Some(h)
        );
        assert_eq!(parse_invite_hash("  https://t.me/+hAJfgmURLbxhYzM0  "), Some(h));
        // Public links / usernames / ids are not invite hashes.
        assert_eq!(parse_invite_hash("@my_group"), None);
        assert_eq!(parse_invite_hash("my_group"), None);
        assert_eq!(parse_invite_hash("-1001234567890"), None);
        assert_eq!(parse_invite_hash("+"), None);
    }

    #[test]
    fn group_username_parsing() {
        assert_eq!(parse_group_username("@my_group"), Some("my_group"));
        assert_eq!(parse_group_username("my_group"), Some("my_group"));
        assert_eq!(parse_group_username("  @spaced  "), Some("spaced"));
        // Numeric specs are ids, not usernames.
        assert_eq!(parse_group_username("-1001234567890"), None);
        assert_eq!(parse_group_username("1234567890"), None);
        // A lone "@" is not a usable username.
        assert_eq!(parse_group_username("@"), None);
    }

    #[test]
    fn group_id_candidate_parsing() {
        // -100… supergroup form yields both the raw parse and the bare id.
        assert_eq!(
            parse_group_id_candidates("-1001234567890"),
            Some(vec![1001234567890, 1234567890])
        );
        // Bare id with no prefix.
        assert_eq!(parse_group_id_candidates("1234567890"), Some(vec![1234567890]));
        // Legacy basic-group negative id.
        assert_eq!(parse_group_id_candidates("-987654"), Some(vec![987654]));
        // Usernames aren't ids.
        assert_eq!(parse_group_id_candidates("my_group"), None);
        assert_eq!(parse_group_id_candidates("@my_group"), None);
        assert_eq!(parse_group_id_candidates(""), None);
    }
}
