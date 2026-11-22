# packages/telegram-storage/ — tgb-telegram-storage

Rust crate implementing a Telegram-backed file store via MTProto. Provides an Axum `Router` plus a sqlx-backed metadata DB. Mounted by [`packages/backend/`](../backend/src/telegram.rs) at `/api/telegram` behind the default-on `telegram` Cargo feature. The backups page is the consumer.

## Cargo crate

- **Name**: `tgb-telegram-storage`
- **Library name**: `tgb_telegram_storage` (`src/lib.rs`)
- **Edition**: 2021
- **Build script**: `build.rs` (used for `grammers` codegen / embedded credentials when applicable)

### Key dependencies

| Dep | Purpose |
|---|---|
| `axum 0.8` (`multipart`) | HTTP framework (the storage router accepts multipart uploads) |
| `tokio 1` (`sync, rt, rt-multi-thread, macros, fs, io-util`) | Runtime |
| `tokio-util 0.7` (`io`) | `ReaderStream` for streaming downloads |
| `tower 0.5` + `tower-http 0.6` (`cors`) | Middleware |
| `sqlx 0.8` (`runtime-tokio, sqlite, chrono, macros`, default-features off) | Metadata DB |
| `grammers-client 0.9` (default-features off, `fs`) | MTProto client |
| `grammers-mtsender 0.9` | MTProto transport |
| `grammers-session 0.9` (default-features off, `serde`) | Session persistence |
| `grammers-tl-types 0.9` | Telegram TL schema |
| `chrono 0.4` (`serde`) | Timestamps |
| `uuid 1` (`v4`) | File IDs |
| `mime_guess 2` | MIME detection |
| `parking_lot 0.12` | Sync primitives |
| `futures-util 0.3` | Stream helpers |
| `anyhow 1`, `thiserror 1` | Errors |

## Source layout

```
packages/telegram-storage/
├── Cargo.toml
├── build.rs
└── src/
    ├── lib.rs        # Public re-exports + Router constructor
    ├── api.rs        # Axum handlers (upload / download / list / delete / files/<id>)
    ├── auth.rs       # MTProto 3-step auth (phone → code → optional 2FA)
    ├── client.rs     # grammers Client wrapper
    ├── config.rs     # Config struct (api_id, api_hash, chat title, data root)
    ├── db.rs         # sqlx schema + queries (tg_files, tg_file_part, tg_pending_part multipart staging + heal_and_mint_multipart)
    ├── download.rs   # File download / streaming
    ├── error.rs      # thiserror Error type
    ├── media_type.rs # `is_allowed(name, mime)`: zip-only allowlist consulted by every upload entry point
    ├── backup.rs     # content fingerprint in the stored name, stripped again by the API
    ├── pool.rs       # sqlx pool helpers
    ├── session.rs    # grammers-session persistence
    ├── state.rs      # Shared state struct (client + db pool)
    └── upload.rs     # Multipart upload + chunking for files > MAX_CHUNK_BYTES
```

## Wiring (when ready)

```toml
# packages/backend/Cargo.toml
[features]
telegram = ["dep:tgb-telegram-storage"]

[dependencies]
tgb-telegram-storage = { path = "../telegram-storage", optional = true }
```

```rust
// packages/backend/src/lib.rs
#[cfg(feature = "telegram")]
pub mod telegram_wiring {
    pub async fn router(config: tgb_telegram_storage::Config) -> anyhow::Result<axum::Router> {
        tgb_telegram_storage::api::router(config).await
    }
}
```

Gate behind a Cargo feature so non-Telegram builds skip the heavy MTProto deps entirely. The Movies/Player split in `tgb.git` is the reference for how to do this cleanly.

## Conventions

- **Allowlist**: every upload entry point routes through `media_type::is_allowed(name, mime)` and takes only `.zip` files (415 otherwise). The reconcile applies it to documents without a tgb marker too.
- **Backup identity**: the engine resumes and reconciles on `(name, size)`, so `upload_stream` first hashes the content and stores it as `<stem>.tgb-<12 hex>.zip`. Never upload around it, or versions with the same name and size will mix.
- **Login code delivery**: `auth.rs` invokes `auth.sendCode` / `auth.resendCode` / `auth.signIn` directly instead of grammers' `request_login_code` / `sign_in`, because grammers discards `auth.SentCode.type` — without it the UI can't say whether the code went to the Telegram app, SMS, a call, or the account's login email (or that Telegram demands a login email first, `setup_email_required`). The resulting `CodeDelivery` (`method`, `length`, `emailPattern`, `nextMethod`, `timeoutSecs`) is logged, returned from `POST /auth/start` + `POST /auth/resend`, and surfaced as `codeDelivery` on `GET /status`; the shared `TelegramAuthWizard` renders it via `$utils/telegram/codeDelivery` with a "Resend via …" button when `nextMethod` is set. `request_code` follows `PHONE_MIGRATE` (303) itself (switch home DC + `disconnect_from_dc`), and `complete_login` mirrors grammers' private one (cache the self peer + seed update state in the session). `POST /auth/code` keeps the pending code on a wrong entry, so a typo doesn't force a new code.
- **QR-code login** (for when Telegram reports a code as sent but it never arrives — it happens for some `api_id`s / accounts, and Telegram offers no resend): `POST /auth/qr` runs one `auth::qr_login_step` — `auth.exportLoginToken` → `{ outcome: "pending", url: "tg://login?token=<base64url>", expiresAt }` while unapproved (the token is stable until it expires, so the QR doesn't churn), `auth.loginTokenMigrateTo` → switch home DC + `auth.importLoginToken`, `auth.loginTokenSuccess` → `complete_login` → `{ outcome: "authenticated", user }`, and `SESSION_PASSWORD_NEEDED` → `{ outcome: "passwordRequired", hint }` with `LoginInProgress::AwaitingPassword` set so the normal `POST /auth/password` finishes it. The SPA's `telegramService.startQrLogin()` polls it every 3 s (exposing the current QR on `telegramService.qrLogin`), and `TelegramAuthWizard` renders it via `core/QrCode` when the user picks "Log in with a QR code" — approved from the phone's Telegram under Settings → Devices → Link Desktop Device.
- **Credentials**: support three fallback layers — user-supplied JSON at `<data_root>/telegram/credentials.json` → runtime env vars (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`) → build-time embedded constants from `build.rs`. Never log credentials.
- **Single shared storage group (when access-gated)**: when `TGB_TELEGRAM_ACCESS_GROUP` is set, that one group is BOTH the login-gate group AND the storage destination — `client.rs::ConnectedClient::target_peer` resolves the access-group spec to a shared `PeerRef` (via `resolve_access_group_peer`) and every upload / download / delete / reconcile / catalog scan targets it, so **all authorized members read and write the same group** (a file uploaded by one member is visible to every member — one shared catalog). It is the ONLY storage destination; the shared group is created once out-of-band by whoever owns the spec, and the crate only ever resolves + reuses it (it never `channels.createChannel`s in this mode). The invite-link shape reuses the membership probe's `messages.checkChatInvite` — its `ChatInviteAlready { chat }` carries the joined chat, so the peer (id + access-hash) comes straight off it with no dialog walk; `@username` → `resolve_username` → `to_ref`; numeric id → dialog walk. If the group can't be resolved for a signed-in account (not a member / unusable spec) `target_peer` returns a hard error rather than silently falling back to a per-user chat (fail closed). With `TGB_TELEGRAM_ACCESS_GROUP` **unset**, `target_peer` returns an error — there is no fallback: the crate never creates a per-user group and never uses Saved Messages (there is no `chat_title` / `TGB_TELEGRAM_CHAT_TITLE` anymore).
- **Access control (group-membership login gate)**: when `TGB_TELEGRAM_ACCESS_GROUP` is set, only Telegram accounts that belong to that group pass the login gate — being signed in is necessary but not sufficient. The spec accepts a **private invite link** (`t.me/+<hash>` / `joinchat/<hash>` / a bare `+<hash>`), a public `@username`, or a numeric chat id (the `-100…` supergroup form or the bare id); blank/unset disables gating (any signed-in account is authorized, preserving the historical behaviour). Read in `client.rs::access_group_from_env` at `ConnectedClient::connect` time (mirroring `credentials_from_env`, so it's zero-churn across the crate's `TelegramConfig` sites and ships in the APK via the embedded `.env`). The check (`ConnectedClient::probe_membership`) branches by spec shape: an **invite link** → `messages.checkChatInvite` (`ChatInviteAlready` ⇒ member; `ChatInvite`/`ChatInvitePeek` ⇒ not — the only shape that works for a private group with no public username, addressed solely by its link); a `@username` → `client.resolve_username` (works regardless of membership); a numeric id → walking the user's own dialogs (a member always has the group in their dialog list — keep private groups un-archived). Username/id verdicts are confirmed authoritatively with `client.get_permissions` (`USER_NOT_PARTICIPANT` ⇒ not a member). The verdict is cached per connection in `access_cache: Mutex<Option<(bool, Instant)>>` so `GET /status` (polled every 5 s) doesn't re-probe — the cache is treated as stale after `ACCESS_CACHE_TTL` (1 h, matching the bypass-cookie lifetime) so membership is re-verified against Telegram at most once an hour; transient errors aren't cached (so they retry), and `POST /access/recheck` clears the cache so a freshly-added member doesn't need a backend restart. `GET /status` surfaces `signedIn` + `authorized` + `accessDenied` + `accessGroupRequired` + `accessGroupInvite` (`accessGroupRequired` is `client.rs::access_group_configured()` = whether the deployment gates on a group at all — read fresh from the env so it's known even before a client connects, letting the login UI advertise the requirement up front rather than only after a denial; `accessGroupInvite` is `client.rs::access_group_invite_url()` = a shareable `https://t.me/…` link derived from the same spec — `+<hash>` invite → `t.me/+<hash>`, `@username` → `t.me/<username>`, numeric id → `null` — so the UI can render a "join this group" link + QR code for non-members). The SPA's `TelegramLoginGate` (flix `+layout`) shows an "restricted to members of a specific group" info note while `accessGroupRequired && !accessDenied`, and the `TelegramAccessDenied` screen (re-check / sign-out) when `accessDenied`; the flix `/telegram` page mirrors both — the requirement note beside the auth wizard, a "verifying membership" state while the probe runs, and the `TelegramAccessDenied` screen (instead of the phone wizard) for a signed-in non-member. Both the requirement note and the `TelegramAccessDenied` screen render the shared `TelegramGroupInvite` component (`components/telegram/`, built on the reusable `components/core/QrCode.svelte` — `qrcode-generator` → inline SVG) showing the `accessGroupInvite` link, a copy-to-clipboard button, an "Open in Telegram" link, and its QR code, so a non-member can join.
- **Bypass cookie (`access_cookie.rs`)**: once a signed-in account clears the group gate, `GET /status` mints a **signed, 1-hour cookie** (`tgb_access`, `HttpOnly`, `SameSite=Lax`, `Max-Age=3600`) bound to that account's Telegram user id. The token is `"{user_id}.{exp}.{hmac_hex}"` signed with HMAC-SHA256; the key is 32 random bytes persisted `0600` at `<data_root>/telegram/access_cookie.key` (`AccessKey::load_or_create`, threaded onto `Inner.access_key`). While a valid cookie whose `user_id` matches the signed-in account is presented, the status handler returns `authorized` **without** running the membership probe (the fast path); a missing / expired / mismatched cookie falls through to `access_allowed` and, on a pass, re-mints the cookie via `Set-Cookie`. So after a backend restart the cookie keeps working (stateless, no server-side session map) until it self-expires, then the next routine poll re-probes + re-issues — transparently. The cookie can be presented but not forged (the HMAC key never leaves the server), and it only skips the *membership probe*: the real auth boundary is still the MTProto session. The frontend additionally persists a local `telegram:authorized-until` hint (`telegram.service.ts`) so a reload within the window opens the UI instantly instead of flashing the gate before the first cookie-backed poll resolves.
- **Chunked uploads**: every logical file is split into ≤ `upload::MAX_CHUNK_BYTES` (50 MiB) Telegram messages. Each chunk goes through a hand-rolled MTProto loop (`upload.saveBigFilePart` at 512 KiB stride) instead of `grammers-client::Client::upload_stream` — the custom path adds per-part retry with exponential backoff, sub-second-responsive pause/resume, and cooperative abort. Chunks are processed **sequentially** (so the full-file hash streams in order and the DB rows land in order), but within each chunk up to `upload::PART_CONCURRENCY` (8) 512 KiB parts fly **concurrently**, each dispatched over one of the dedicated upload connections (see below) round-robin — so a single MTProto connection's request-at-a-time latency stops bounding throughput. The fresh-upload path **streams** the chunk from the source reader 512 KiB at a time (resident memory ≈ `PART_CONCURRENCY * 512 KiB`, not a whole 50 MiB chunk); only a *resume candidate* (a chunk that may already be on Telegram) is buffered whole, so its full hash can be compared before deciding to skip. Outer ceiling: `MAX_UPLOAD_BYTES` (200 GiB).
- **Dedicated upload connections**: grammers' `SenderPool` keeps a single connection per DC, which caps upload throughput; Telegram permits the same auth key on several simultaneous connections (this is how official clients parallelise transfers). `ConnectedClient::ensure_upload_pool` lazily opens `client::UPLOAD_CONNECTIONS` (4) extra senders over the same `FileSession` (reusing the bound auth key via grammers' `connect_with_auth`, so no re-login) on the first upload, pre-warming each with a `help.getConfig` and dropping any that fail — degrading to the main connection if none come up. `upload_client_rr()` hands the chunk part-loop a round-robin client per part. `shutdown()` quits them alongside the main pool.
- **Concurrent background uploads (bounded)**: every background upload goes through `uploads::spawn_upload`, which returns an `uploadId` immediately and spawns a detached task — each task acquires a fair permit from `UploadRegistry::acquire_gate` (a `tokio::sync::Semaphore(uploads::MAX_CONCURRENT_UPLOADS)`, currently **2**) before it touches Telegram and holds it until the transfer ends. So no matter how many acquisition / manual uploads are kicked off at once, at most `MAX_CONCURRENT_UPLOADS` push to Telegram concurrently (each already fanning its parts across the upload connections); the rest queue FIFO. While a task waits in line its snapshot stays `Running` with `transfer_started_at == None` (the acquisition upload activity's poll loop treats `Running` as "keep waiting"; the SPA renders it as "Queued"), and a cancel issued while queued is honoured the moment it acquires the gate (short-circuits to `Cancelled` without uploading). A *paused* upload holds its permit. Raise `MAX_CONCURRENT_UPLOADS` to allow more concurrency.
- **Honest progress / ETA**: `UploadSnapshot` carries both `started_at` (enqueue time) and `transfer_started_at` (set when the gate is acquired and bytes actually start). The SPA measures upload speed over a **trailing window** of samples anchored at `transfer_started_at`, not a since-enqueue average — the latter is polluted by the queue wait and inflates the ETA to hours.
- **Resumable uploads (chunk-level, seek-skip)**: `upload::upload` is resumable across attempts (its source `S` must be `AsyncRead + AsyncSeek + Unpin` — every real caller feeds a local `fs::File`, so this holds). Before minting a fresh `tg_files.id` it calls `db::find_resumable(name, size_bytes)` — an *interrupted* prior attempt at the same logical file (same name + size, whose full-file `checksum_sha256` is still NULL because it never completed) is reused into that existing row id. For each chunk that already has a `tg_file_part` row of the **matching `size_bytes`**, the upload **seeks the source forward past that chunk** — no read, no re-hash — and only the missing/wrong-size chunks go over the wire. This is the key perf property: a resume pays for the chunks that still have to be pushed, not for re-reading + re-hashing every landed 50 MiB (on a slow disk that local read dominated resume time — the visible "skipping chunk N/51 …" spam was seconds apart). **Trade-off**: because seeking skips those bytes, the streaming full-file digest can't be completed, so a seek-resumed file's `checksum_sha256` is left **NULL** — exactly the state a cross-device reconcile produces (chunk markers never carry the full-file checksum anyway, only per-chunk ones), and both `verify()` (skips NULL with a warning) and playback tolerate it. A fresh upload (no resume, zero skips) still streams every byte through the hasher and writes the checksum exactly as before. A stale part row of the *wrong* size falls through, is read + re-uploaded, and `db::insert_part` upserts on `(tg_file_id, ord)`. Since a completed seek-resume leaves the checksum NULL, `find_resumable` may match the same row on a later re-run — that's fine and now cheap: it fast-seeks through all present chunks and finalizes without re-pushing. Content-level dedup (`find_by_checksum`) is a separate, largely-unused concern — the active dedup path is filename-based (`upload_local_file_dedup` → `find_by_name`).
- **Accumulative multipart reconstruction (cross-device / Android strand fix)**: a second device rebuilds `tg_files` purely by walking the chat, and a multipart file only mints once *all* its chunks are observed. A single walk isn't guaranteed to see them all — concurrent uploads interleave their 50 MiB chunk messages across a wide id range, and a bounded / rate-limited / interrupted mobile walk can miss some — so the catalog scan (`ReconcileFilter::All`) now **stages every observed chunk** in `tg_pending_part` keyed by `(groupId, ord)`. `walk_and_mint` seeds its in-memory groups from that table at the start of each walk, so observations **accumulate across walks** until a group is complete, at which point `db::heal_and_mint_multipart` mints it and its staging rows are cleared. Crucially it **no longer skips a chunk just because a `tg_file_part` row already exists** for its message id — that old skip stranded a file forever once a partial / interrupted mint left stale part rows behind (the "second device / Android only sees N-1 files" bug). Instead `heal_and_mint_multipart` reconciles against the DB: it leaves an already-healthy complete file untouched (stable id preserved), and re-mints a broken / poisoned one after purging its stale head + part rows. Staging is scoped to the `All` catalog scan; the targeted `MediaForPipeline` / `MetadataOnly` walks stay single-pass.
- **Restores**: only complete backups download (`409 backup_incomplete` otherwise). Message ids go to Telegram at most 100 per call, and each chunk message is re-fetched just before streaming because file references expire.
- **Checksums**: the upload streams a `Sha256` digest of the full logical file (lands in `tg_files.checksum_sha256`) plus one digest per chunk (`tg_file_part.checksum_sha256`). Both also ride inside the chunk's `tgb-multipart` caption marker (`checksum`, `partChecksum`) so cross-device reconcile can recover them without downloading. `TelegramStorage::verify(id)` re-downloads end-to-end and compares against the stored digest.
- **Caller-supplied metadata**: `UploadRequest::metadata` takes an arbitrary `serde_json::Value` that the storage crate never interprets. It's serialised verbatim into `tg_files.metadata` and stamped into every chunk's `tgb-multipart` marker so a fresh device walking the chat recovers it. Use this for firkin ids, source URLs, custom tags — anything the consuming crate needs but the storage crate shouldn't know about.
- **Caption marker format**: keep the `tgb-multipart` JSON schema stable — it's the format both the reconciler and v1-aware clients read. The parser in `client.rs::parse_multipart_marker` accepts `v: 1` (legacy: `caption` only) and `v: 2` (current: adds `checksum`, `partChecksum`, `metadata`); the upload path always writes v2.
- **Session storage**: persist `grammers-session` to disk under `<data_root>/telegram/session/`. Sessions are sensitive — `chmod 0600`.
- **Errors**: use `thiserror` for the crate-level error type, convert to HTTP responses via `IntoResponse`. Note the two new variants: `ChecksumMismatch { expected, actual }` (422) and `UploadAborted` (409).
- **Test**: `cargo test -p tgb-telegram-storage`. Don't hit the real Telegram API in unit tests — mock at the `grammers-client` boundary.

## Filesystem API (Rust callers)

`TelegramStorage` is the canonical handle — other crates in the workspace import it and use it as a file store. Method shape:

| Method | Purpose |
|---|---|
| `upload_stream(request, AsyncRead)` | Push an arbitrary reader. No dedup. |
| `upload_local_file(path, request)` | Same, but the source is a file on disk. |
| `upload_local_file_dedup(path, request)` | Filename-deduped upload; runs the chat → SQLite reconcile once per session. Returns `UploadOutcome::Uploaded \| AlreadyExists`. |
| `list()` / `get(id)` / `find_by_name(name)` / `find_by_checksum(hex)` | Index queries. |
| `reconcile_index_once()` | Run the full chat → `tg_files` reconcile (the `All` walk `upload_local_file_dedup` runs internally), minting every media file — including single-chunk documents like the shared `.vtt` subtitles — the chat holds into the local index. `OnceCell`-guarded per connection (no-op after the first call in a session); `Ok(None)` when nobody is signed in. Use before a `find_by_name` that must see files uploaded by another device (the subtitle store's Telegram lookup does). |
| `file_message_ids(id)` | Resolve a stored file's `FileMessageIds { head_message_id, part_message_ids }` — the head (chunk-0 / "master") message id + every chunk's message id in `ord` order. Pure index read. `None` when `id` is unknown. |
| `send_reply(reply_to_message_id, text, document_path)` | Send a message into the chat as a native reply to an existing message (`InputMessage::reply_to`). Optional text body + optional document attachment (a JSON sidecar). Returns the new message id. Used by the `telegram-upload-metadata` connector to thread movie metadata under an uploaded video's master message. |
| `scan_chain_catalog()` | Walk the chat once and recover the connector/chain catalog graph the file index can't express: the `*-metadata` reply messages (`movie-metadata` / `album-metadata` / `tv-episode-metadata`, plus the `movie-request` / `tv-request` markers the SPA's Request button posts) — sent as plain-text / photo-caption / JSON-document replies that never land in `tg_files` — plus the head-chunk `reply_to` edge for every uploaded media file (which the catalog uses to detect a file a bounded walk saw but never minted). Mints the chain media files into `tg_files` along the way (runs the `All` reconcile filter) so playback resolves. Returns `ChainCatalogScan { metadata_messages, media_links }`. **Not** `OnceCell`-gated (unlike `reconcile_*`) — the consumer (`/api/catalog/tree`) caches the assembled tree and only re-walks on an explicit refresh. Backs the `/catalog` page; oversized `*-metadata` JSON documents are downloaded + parsed inline (bounded). |
| `download(id)` / `download_range(id, start, end)` | Returns `(FileRow, DownloadStream)` — receiver of `Result<Vec<u8>, _>` chunks. |
| `download_to_dir(id, target_dir)` / `download_to_bytes(id, max_bytes)` | Convenience sinks. |
| `verify(id)` | Re-download and check the stored SHA-256. |
| `delete(id)` / `delete_if_exists(id)` / `delete_all()` | Remove from chat + index. `delete` 404s on an unknown id; `delete_if_exists` treats unknown as success (for a title "nuke" where already-gone is the goal); `delete_all` wipes the whole chat + index. |
| `delete_messages(ids)` | Best-effort raw delete of arbitrary message ids from the destination chat, **without** touching the file index — for the `*-metadata` reply messages the acquisition stack threads (which never land in `tg_files`). Batched by 100; already-deleted ids ignored; empty list is a no-op. |

`UploadRequest` is a builder-style struct — `UploadRequest::new(name, mime, total_size).with_metadata(json).with_progress(cb).with_pause(arc).with_abort(arc)`.

`UploadProgress { bytes_uploaded, total_bytes, chunk_index, total_chunks, chunk_bytes_uploaded }` is delivered to the progress callback after every acknowledged 512 KiB piece, so a 50 MiB chunk advances the byte counter ~100 times instead of jumping 0 → 50 MiB.
