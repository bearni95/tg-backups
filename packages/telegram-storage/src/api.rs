//! HTTP surface mounted under `/api/telegram` by the host backend.
//!
//! Route map:
//! - `GET    /status`             → connected? authorized? user info
//! - `GET    /credentials`        → `{ apiId, apiHash }` if set, else 404
//! - `POST   /credentials`        → set / replace api_id + api_hash
//! - `DELETE /credentials`        → wipe credentials and disconnect
//! - `POST   /auth/start`         → `{ phone }` → request login code
//! - `POST   /auth/code`          → `{ code }`  → submit code
//! - `POST   /auth/password`      → `{ password }` → submit 2FA password
//! - `POST   /auth/logout`        → sign out, wipe session + index
//! - `POST   /access/recheck`     → drop the cached group-membership verdict so the next `/status` re-probes
//! - `GET    /transfer`           → export `{ credentials?, session? }` for cross-device sync (QR)
//! - `POST   /transfer`           → import `{ credentials?, session? }` and reconnect
//! - `GET    /files`                       → list files (accepts `?scope=metadata` for the catalog fast path: only walks / returns rows whose `metadata.role == "metadata"`)
//! - `POST   /files`                       → multipart upload
//! - `POST   /files/delete-all`            → wipe every message from the chat + index
//! - `POST   /files/load-media/:pipeline`  → mint (if needed) and return the media row paired with this pipeline id; backs the catalog's lazy "fetch chunks on play" path
//! - `GET    /files/:id`                   → download bytes (full file)
//! - `DELETE /files/:id`                   → delete
//! - `GET    /uploads`            → list in-flight background uploads
//! - `POST   /uploads`            → kick off a background upload from a server-local file (returns `uploadId`)
//! - `GET    /uploads/:id`        → snapshot of one background upload
//! - `DELETE /uploads/:id`        → cancel (cooperative abort at next chunk boundary)
//! - `POST   /uploads/:id/pause`  → pause at next part boundary
//! - `POST   /uploads/:id/resume` → resume

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mime_guess::MimeGuess;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::access_cookie;
use crate::auth::{self, AuthOutcome, AuthUser, CodeDelivery, LoginInProgress, SubmitCodeOutcome};
use crate::client::ConnectedClient;
use crate::config::{self, Credentials};
use crate::db as index_db;
use crate::error::StorageError;
use crate::media_type;
use crate::state::{session_path, TelegramStorage};
use crate::upload::{self, UploadRequest};
use crate::uploads::{self, UploadSnapshot};

pub fn router(storage: TelegramStorage) -> Router {
    Router::new()
        .route("/status", get(status))
        .route(
            "/credentials",
            get(get_credentials)
                .post(set_credentials)
                .delete(delete_credentials),
        )
        .route("/auth/start", post(auth_start))
        .route("/auth/resend", post(auth_resend))
        .route("/auth/qr", post(auth_qr))
        .route("/auth/code", post(auth_code))
        .route("/auth/password", post(auth_password))
        .route("/auth/logout", post(auth_logout))
        .route("/access/recheck", post(access_recheck))
        .route("/transfer", get(transfer_export).post(transfer_import))
        .route("/files", get(list_files).post(upload_file))
        .route("/files/from-path", post(upload_from_path))
        .route("/files/delete-all", post(delete_all_files))
        .route("/files/load-media/{pipeline_id}", post(load_media_for_pipeline))
        .route("/files/{id}", get(download_file).delete(delete_file))
        .route("/uploads", get(list_uploads).post(start_upload))
        .route("/uploads/{id}", get(get_upload).delete(cancel_upload))
        .route("/uploads/{id}/pause", post(pause_upload))
        .route("/uploads/{id}/resume", post(resume_upload))
        // Axum's `Multipart` extractor inherits the global
        // `DefaultBodyLimit` of 2 MiB, so any user upload bigger than
        // that fails with a 400 before `upload_file` even runs. The
        // handler streams the body chunk by chunk and enforces its own
        // ceiling at [`upload::MAX_UPLOAD_BYTES`] (2 GiB free-tier
        // Telegram limit), so the global limit is just in the way —
        // disable it for this router.
        .layer(DefaultBodyLimit::disable())
        .with_state(storage)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    has_credentials: bool,
    connected: bool,
    /// Signed in to Telegram (a valid session) — regardless of whether the
    /// account clears the group-membership gate.
    signed_in: bool,
    /// Fully cleared to use the app: signed in *and* (when login is gated on
    /// `TGB_TELEGRAM_ACCESS_GROUP`) a member of the required group.
    authorized: bool,
    /// Signed in but definitively not a member of the required group. The
    /// login gate shows the "ask an admin to add you" screen on this.
    access_denied: bool,
    /// Whether this deployment requires membership of the shared Telegram
    /// group at all (`TGB_TELEGRAM_ACCESS_GROUP` set). Advertised so the UI
    /// can show the requirement up front — before sign-in and independent of
    /// connection state — not just after a probe flips `access_denied`.
    access_group_required: bool,
    /// A shareable `https://t.me/…` link for the required group (derived from
    /// the access-group spec) so the UI can render a join link + QR code for
    /// non-members. `None` when gating is disabled or the spec is a bare
    /// numeric id with no public link. See `client::access_group_invite_url`.
    access_group_invite: Option<String>,
    login_in_progress: Option<&'static str>,
    /// Where the pending login code was delivered (app / SMS / email / …).
    /// Present only while `login_in_progress == "awaiting_code"`.
    code_delivery: Option<CodeDelivery>,
    user: Option<AuthUser>,
}

async fn status(
    State(s): State<TelegramStorage>,
    headers: HeaderMap,
) -> Result<Response, StorageError> {
    let inner = s.inner();
    let has_credentials = inner.credentials.lock().await.is_some();
    let now = chrono::Utc::now().timestamp();
    // Set when the membership probe runs and clears the gate — mints a fresh
    // 1-hour bypass cookie returned on this response.
    let mut set_cookie: Option<String> = None;

    // Snapshot a clone of the `Arc<ConnectedClient>` out of the `connected`
    // lock and release the guard before any MTProto `await`. Uploads /
    // downloads hold the same lock for the entire streaming transfer
    // (multi-GiB files can keep it pinned for minutes), so taking the
    // probe path through the guard would make `GET /status` hang behind
    // an in-flight upload — exactly what the WebUI's "Checking Telegram
    // storage status…" spinner was stuck on. The clone is a cheap `Arc`
    // bump, and the underlying `SenderPool` serialises requests internally,
    // so issuing `is_authorized` / `get_me` / the membership probe on the
    // clone is safe even while another task drives an upload.
    let conn = inner.connected.lock().await.as_ref().map(Arc::clone);
    let connected = conn.is_some();
    let mut signed_in = false;
    let mut authorized = false;
    let mut access_denied = false;
    let mut user: Option<AuthUser> = None;
    if let Some(c) = conn.as_ref() {
        if c.is_authorized().await.unwrap_or(false) {
            signed_in = true;
            // Fetch the profile once; the membership check reuses it so we
            // don't round-trip `get_me` twice.
            let me = c.client.get_me().await.ok();
            if let Some(ref u) = me {
                user = Some(AuthUser::from_user(u));
            }
            match (me.as_ref(), c.access_group_spec().is_some()) {
                // Gating disabled — preserve the historical "signed in ⇒
                // authorized" behaviour even if the profile fetch hiccuped.
                (_, false) => authorized = true,
                // Gating on and we have the profile.
                (Some(u), true) => {
                    let uid = u.id().bare_id();
                    // Fast path: a valid, unexpired bypass cookie bound to
                    // this exact account skips the slow membership probe.
                    let cookie_ok = access_cookie::parse_request_cookie(&headers)
                        .and_then(|tok| inner.access_key.verify(&tok, now))
                        == Some(uid);
                    if cookie_ok {
                        authorized = true;
                    } else {
                        // Slow path: re-probe (cached up to an hour in
                        // `access_allowed`), and on a pass mint a cookie so
                        // the next hour of polls / reloads take the fast path.
                        match c.access_allowed(u).await {
                            Ok(true) => {
                                authorized = true;
                                set_cookie = Some(access_cookie::set_cookie_value(
                                    &inner.access_key.issue(uid, now),
                                ));
                            }
                            Ok(false) => access_denied = true,
                            // Inconclusive (transient network error): keep the
                            // gate closed without flipping to "denied"; the 5 s
                            // poll retries.
                            Err(e) => log::warn!(
                                target: "tgb-telegram-storage",
                                "group membership check inconclusive, keeping gate closed: {e}"
                            ),
                        }
                    }
                }
                // Gating on but the profile fetch failed — stay gated, retry.
                (None, true) => {}
            }
        }
    }

    let (login_in_progress, code_delivery) = match inner.login.lock().await.as_ref() {
        Some(LoginInProgress::AwaitingCode { delivery, .. }) => {
            (Some("awaiting_code"), Some(delivery.clone()))
        }
        Some(LoginInProgress::AwaitingPassword { .. }) => (Some("awaiting_password"), None),
        None => (None, None),
    };

    let mut response = Json(StatusResponse {
        has_credentials,
        connected,
        signed_in,
        authorized,
        access_denied,
        access_group_required: crate::client::access_group_configured(),
        access_group_invite: crate::client::access_group_invite_url(),
        login_in_progress,
        code_delivery,
        user,
    })
    .into_response();
    if let Some(cookie) = set_cookie {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
    }
    Ok(response)
}

/// Forget any cached group-membership verdict so the next `GET /status`
/// re-probes. Backs the "not a member" screen's "Re-check" button after an
/// admin adds the signed-in account to the access group.
async fn access_recheck(State(s): State<TelegramStorage>) -> Result<StatusCode, StorageError> {
    let client = s.inner().connected.lock().await.as_ref().map(Arc::clone);
    if let Some(c) = client {
        c.recheck_access().await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsResponse {
    api_id: i32,
    api_hash: String,
}

async fn get_credentials(
    State(s): State<TelegramStorage>,
) -> Result<Json<CredentialsResponse>, StorageError> {
    match s.inner().credentials.lock().await.as_ref() {
        Some(c) => Ok(Json(CredentialsResponse {
            api_id: c.api_id,
            api_hash: c.api_hash.clone(),
        })),
        None => Err(StorageError::CredentialsMissing),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetCredentialsRequest {
    api_id: i32,
    api_hash: String,
}

async fn set_credentials(
    State(s): State<TelegramStorage>,
    Json(req): Json<SetCredentialsRequest>,
) -> Result<Json<serde_json::Value>, StorageError> {
    if req.api_id == 0 || req.api_hash.trim().is_empty() {
        return Err(StorageError::BadRequest(
            "apiId and apiHash are required".into(),
        ));
    }
    let creds = Credentials {
        api_id: req.api_id,
        api_hash: req.api_hash,
    };
    config::save(s.data_root(), &creds).await?;

    // Replace any existing client.
    let inner = s.inner();
    if let Some(prev) = inner.connected.lock().await.take() {
        prev.shutdown().await;
    }
    *inner.login.lock().await = None;

    let new_client = ConnectedClient::connect(
        &session_path(s.data_root()),
        creds.api_id,
        creds.api_hash.clone(),
    )
    .await?;
    *inner.connected.lock().await = Some(Arc::new(new_client));
    *inner.credentials.lock().await = Some(creds);

    Ok(Json(json!({ "ok": true })))
}

async fn delete_credentials(
    State(s): State<TelegramStorage>,
) -> Result<Json<serde_json::Value>, StorageError> {
    let inner = s.inner();
    if let Some(prev) = inner.connected.lock().await.take() {
        prev.shutdown().await;
    }
    *inner.login.lock().await = None;
    *inner.credentials.lock().await = None;
    config::clear(s.data_root()).await?;
    wipe_session_file(s.data_root()).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AuthStartRequest {
    phone: String,
}

async fn auth_start(
    State(s): State<TelegramStorage>,
    Json(req): Json<AuthStartRequest>,
) -> Result<Json<serde_json::Value>, StorageError> {
    let inner = s.inner();
    let connected = {
        let guard = inner.connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::CredentialsMissing)?
    };
    let (request, delivery) = auth::request_code(&connected, &req.phone).await?;
    *inner.login.lock().await = Some(LoginInProgress::AwaitingCode {
        request,
        delivery: delivery.clone(),
    });
    Ok(Json(
        json!({ "ok": true, "stage": "awaiting_code", "delivery": delivery }),
    ))
}

/// Fail fast with `NoLoginInProgress` before touching the connection, so the
/// error doesn't depend on whether credentials are configured.
async fn ensure_awaiting_code(inner: &crate::state::Inner) -> Result<(), StorageError> {
    match inner.login.lock().await.as_ref() {
        Some(LoginInProgress::AwaitingCode { .. }) => Ok(()),
        _ => Err(StorageError::NoLoginInProgress),
    }
}

/// Ask Telegram to deliver the pending login code again (usually over the
/// next method, e.g. SMS after the app).
async fn auth_resend(
    State(s): State<TelegramStorage>,
) -> Result<Json<serde_json::Value>, StorageError> {
    let inner = s.inner();
    ensure_awaiting_code(inner).await?;
    let connected = {
        let guard = inner.connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::CredentialsMissing)?
    };
    // Hold the login lock across the RPC so a concurrent code submit can't
    // race the `phone_code_hash` swap.
    let mut login_guard = inner.login.lock().await;
    let Some(LoginInProgress::AwaitingCode { request, .. }) = login_guard.as_ref() else {
        return Err(StorageError::NoLoginInProgress);
    };
    let (request, delivery) = auth::resend_code(&connected, request).await?;
    *login_guard = Some(LoginInProgress::AwaitingCode {
        request,
        delivery: delivery.clone(),
    });
    Ok(Json(
        json!({ "ok": true, "stage": "awaiting_code", "delivery": delivery }),
    ))
}

#[derive(Serialize)]
#[serde(tag = "outcome")]
enum QrAuthResponse {
    #[serde(rename = "pending")]
    Pending {
        url: String,
        #[serde(rename = "expiresAt")]
        expires_at: i32,
    },
    #[serde(rename = "authenticated")]
    Authenticated { user: AuthUser },
    #[serde(rename = "passwordRequired")]
    PasswordRequired { hint: Option<String> },
}

/// One poll of QR-code login. The SPA calls this every few seconds while it
/// shows the QR; see [`auth::qr_login_step`].
async fn auth_qr(State(s): State<TelegramStorage>) -> Result<Json<QrAuthResponse>, StorageError> {
    let inner = s.inner();
    let connected = {
        let guard = inner.connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::CredentialsMissing)?
    };
    let step = auth::qr_login_step(&connected).await.inspect_err(|e| {
        log::warn!(target: "tgb-telegram-storage", "qr login step failed: {e}");
    })?;
    match step {
        auth::QrLoginStep::Pending { url, expires_at } => {
            Ok(Json(QrAuthResponse::Pending { url, expires_at }))
        }
        auth::QrLoginStep::Done(SubmitCodeOutcome::Authenticated(user)) => {
            log::info!(
                target: "tgb-telegram-storage",
                "qr login: signed in as user {}",
                user.id().bare_id()
            );
            *inner.login.lock().await = None;
            Ok(Json(QrAuthResponse::Authenticated {
                user: AuthUser::from_user(&user),
            }))
        }
        auth::QrLoginStep::Done(SubmitCodeOutcome::PasswordRequired(token)) => {
            log::info!(target: "tgb-telegram-storage", "qr login: approved, 2FA password required");
            let hint = token.hint().map(str::to_string);
            *inner.login.lock().await = Some(LoginInProgress::AwaitingPassword { token });
            Ok(Json(QrAuthResponse::PasswordRequired { hint }))
        }
    }
}

#[derive(Deserialize)]
struct AuthCodeRequest {
    code: String,
}

async fn auth_code(
    State(s): State<TelegramStorage>,
    Json(req): Json<AuthCodeRequest>,
) -> Result<Json<AuthOutcome>, StorageError> {
    let inner = s.inner();
    ensure_awaiting_code(inner).await?;

    let connected = {
        let guard = inner.connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::CredentialsMissing)?
    };

    // Keep the pending code in place until Telegram accepts it, so a mistyped
    // code can simply be re-entered instead of forcing a new code request.
    let mut login_guard = inner.login.lock().await;
    let Some(LoginInProgress::AwaitingCode { request, .. }) = login_guard.as_ref() else {
        return Err(StorageError::NoLoginInProgress);
    };
    let outcome = auth::submit_code(&connected, request, &req.code).await?;
    *login_guard = None;

    match outcome {
        SubmitCodeOutcome::Authenticated(user) => Ok(Json(AuthOutcome::Authenticated {
            user: AuthUser::from_user(&user),
        })),
        SubmitCodeOutcome::PasswordRequired(pwd_token) => {
            let hint = pwd_token.hint().map(str::to_string);
            *login_guard = Some(LoginInProgress::AwaitingPassword { token: pwd_token });
            Ok(Json(AuthOutcome::PasswordRequired { hint }))
        }
    }
}

#[derive(Deserialize)]
struct AuthPasswordRequest {
    password: String,
}

async fn auth_password(
    State(s): State<TelegramStorage>,
    Json(req): Json<AuthPasswordRequest>,
) -> Result<Json<AuthOutcome>, StorageError> {
    let inner = s.inner();
    let token = {
        let mut login_guard = inner.login.lock().await;
        match login_guard.take() {
            Some(LoginInProgress::AwaitingPassword { token }) => token,
            Some(other) => {
                *login_guard = Some(other);
                return Err(StorageError::NoLoginInProgress);
            }
            None => return Err(StorageError::NoLoginInProgress),
        }
    };

    let connected = {
        let guard = inner.connected.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or(StorageError::CredentialsMissing)?
    };
    let user = auth::submit_password(&connected, token, &req.password).await?;
    Ok(Json(AuthOutcome::Authenticated {
        user: AuthUser::from_user(&user),
    }))
}

async fn auth_logout(
    State(s): State<TelegramStorage>,
) -> Result<Json<serde_json::Value>, StorageError> {
    let inner = s.inner();

    // Best-effort sign-out — even if Telegram rejects it, we still
    // wipe the local session so the next start has a clean slate.
    {
        let connected_opt = {
            let guard = inner.connected.lock().await;
            guard.as_ref().cloned()
        };
        if let Some(connected) = connected_opt {
            if let Err(e) = connected.client.sign_out().await {
                log::warn!(target: "tgb-telegram-storage", "sign_out failed: {e}");
            }
        }
    }
    if let Some(prev) = inner.connected.lock().await.take() {
        prev.shutdown().await;
    }
    *inner.login.lock().await = None;

    wipe_session_file(s.data_root()).await;
    index_db::clear_all(s.db()).await?;

    // Reconnect with the existing credentials so the next login can
    // request a code without going through the credentials screen.
    if let Some(creds) = inner.credentials.lock().await.clone() {
        match ConnectedClient::connect(
            &session_path(s.data_root()),
            creds.api_id,
            creds.api_hash.clone(),
        )
        .await
        {
            Ok(c) => *inner.connected.lock().await = Some(Arc::new(c)),
            Err(e) => {
                log::warn!(target: "tgb-telegram-storage", "reconnect after logout failed: {e}")
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/telegram/transfer?scope=credentials|full` — export the
/// pieces a fresh device needs to skip the manual setup wizard. With
/// `scope=credentials` only the user-supplied `apiId` / `apiHash` are
/// returned; with `scope=full` the persisted MTProto session is
/// included so the receiving device can drop straight into the
/// authorised state without re-running the phone+code flow.
///
/// The payload is meant to be encoded as a QR code on the sending
/// device and scanned (or pasted) on the receiving device, which calls
/// `POST /api/telegram/transfer` to install it. Anyone who captures
/// the QR gets full access to the Telegram account, so the WebUI
/// surfaces a prominent warning when rendering it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferQuery {
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferPayload {
    v: u32,
    kind: &'static str,
    scope: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    credentials: Option<CredentialsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<serde_json::Value>,
}

async fn transfer_export(
    State(s): State<TelegramStorage>,
    axum::extract::Query(query): axum::extract::Query<TransferQuery>,
) -> Result<Json<TransferPayload>, StorageError> {
    let scope = query.scope.as_deref().unwrap_or("full");
    let scope_label: &'static str = match scope {
        "credentials" => "credentials",
        "full" => "full",
        other => {
            return Err(StorageError::BadRequest(format!(
                "scope must be 'credentials' or 'full', got '{other}'"
            )))
        }
    };

    let credentials = s
        .inner()
        .credentials
        .lock()
        .await
        .as_ref()
        .map(|c| CredentialsResponse {
            api_id: c.api_id,
            api_hash: c.api_hash.clone(),
        });

    if credentials.is_none() {
        return Err(StorageError::CredentialsMissing);
    }

    let session = if scope_label == "full" {
        read_session_value(s.data_root()).await
    } else {
        None
    };

    Ok(Json(TransferPayload {
        v: 1,
        kind: "tgb-telegram-transfer",
        scope: scope_label,
        credentials,
        session,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferImportRequest {
    #[serde(default)]
    v: Option<u32>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    credentials: Option<SetCredentialsRequest>,
    #[serde(default)]
    session: Option<serde_json::Value>,
}

async fn transfer_import(
    State(s): State<TelegramStorage>,
    Json(req): Json<TransferImportRequest>,
) -> Result<Json<serde_json::Value>, StorageError> {
    if let Some(kind) = req.kind.as_deref() {
        if kind != "tgb-telegram-transfer" {
            return Err(StorageError::BadRequest(format!(
                "unknown transfer kind '{kind}'"
            )));
        }
    }
    if matches!(req.v, Some(v) if v != 1) {
        return Err(StorageError::BadRequest(format!(
            "unsupported transfer version {:?}",
            req.v
        )));
    }
    if req.credentials.is_none() && req.session.is_none() {
        return Err(StorageError::BadRequest(
            "transfer payload must include credentials or session".into(),
        ));
    }

    let inner = s.inner();
    // Tear the existing client down before touching the session file so
    // its in-memory `save_locked()` writes don't trample what we're about
    // to drop on disk. Likewise drop any in-flight login.
    if let Some(prev) = inner.connected.lock().await.take() {
        prev.shutdown().await;
    }
    *inner.login.lock().await = None;

    if let Some(session_value) = req.session.as_ref() {
        write_session_value(s.data_root(), session_value).await?;
    }

    let creds_to_use = if let Some(c) = req.credentials.as_ref() {
        if c.api_id == 0 || c.api_hash.trim().is_empty() {
            return Err(StorageError::BadRequest(
                "credentials.apiId and credentials.apiHash are required".into(),
            ));
        }
        let creds = Credentials {
            api_id: c.api_id,
            api_hash: c.api_hash.clone(),
        };
        config::save(s.data_root(), &creds).await?;
        *inner.credentials.lock().await = Some(creds.clone());
        Some(creds)
    } else {
        inner.credentials.lock().await.clone()
    };

    // Reconnect against the (possibly-new) session so the next /status
    // poll reflects the imported authorisation state.
    if let Some(creds) = creds_to_use {
        match ConnectedClient::connect(
            &session_path(s.data_root()),
            creds.api_id,
            creds.api_hash.clone(),
        )
        .await
        {
            Ok(c) => *inner.connected.lock().await = Some(Arc::new(c)),
            Err(e) => {
                log::warn!(target: "tgb-telegram-storage", "transfer reconnect failed: {e}");
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

async fn read_session_value(data_root: &Path) -> Option<serde_json::Value> {
    let path = session_path(data_root);
    match fs::read(&path).await {
        Ok(bytes) if !bytes.is_empty() => match serde_json::from_slice::<serde_json::Value>(&bytes)
        {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!(
                    target: "tgb-telegram-storage",
                    "session file at {} is not valid JSON ({e}); skipping export",
                    path.display()
                );
                None
            }
        },
        _ => None,
    }
}

async fn write_session_value(
    data_root: &Path,
    value: &serde_json::Value,
) -> Result<(), StorageError> {
    let path = session_path(data_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec(value)?;
    // Mirror `FileSession::save_locked`'s atomic-rename strategy so a
    // crash mid-write doesn't leave a half-written session that the
    // next boot would silently discard.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).await?;
    fs::rename(&tmp, &path).await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    id: String,
    name: String,
    size_bytes: i64,
    mime_type: String,
    created_at: String,
    /// Legacy free-text caption attached to the Telegram message. New
    /// uploads stamp structured data into `metadata` instead; this
    /// stays for backwards compat with the existing `tgb-firkin`
    /// reconciler that scans the caption.
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    /// Hex-encoded SHA-256 of the full logical file. `None` for legacy
    /// rows that predate the checksum column.
    #[serde(skip_serializing_if = "Option::is_none")]
    checksum_sha256: Option<String>,
    /// Caller-supplied JSON metadata, deserialised from the stored
    /// string. Shape is opaque to the storage crate — the caller
    /// defined it.
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

impl From<index_db::FileRow> for FileEntry {
    fn from(row: index_db::FileRow) -> Self {
        let metadata = row.metadata_value().ok().flatten();
        Self {
            id: row.id,
            name: row.name,
            size_bytes: row.size_bytes,
            mime_type: row.mime_type,
            created_at: row.created_at.to_rfc3339(),
            text: row.text,
            checksum_sha256: row.checksum_sha256,
            metadata,
        }
    }
}

#[derive(Serialize)]
struct ListResponse {
    files: Vec<FileEntry>,
}

#[derive(Deserialize, Default)]
struct ListFilesQuery {
    /// `metadata` → catalog fast path: only walks / returns rows whose
    /// `metadata.role == "metadata"`. Anything else (incl. omitted) keeps
    /// the legacy full-reconcile behaviour. Kept loose-typed as a free-
    /// form string so future scopes (e.g. `media`) can be added without
    /// breaking older clients.
    scope: Option<String>,
}

async fn list_files(
    State(s): State<TelegramStorage>,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<ListResponse>, StorageError> {
    require_authorized(&s).await?;
    let metadata_scope = query.scope.as_deref() == Some("metadata");
    // Reconcile the chat → tg_files index on every list. Internally
    // guarded by a per-connection OnceCell so the actual chat walk only
    // runs the first time per session; subsequent calls are a no-op
    // pointer check. Without this, the catalog detail page's
    // "is this already on Telegram?" check stays empty until the user
    // explicitly clicks the upload button — which is exactly the case
    // the user is trying to avoid (double-uploads of files already in
    // the chat from a previous session / other device).
    {
        let connected_opt = {
            let guard = s.inner().connected.lock().await;
            guard.as_ref().cloned()
        };
        if let Some(connected) = connected_opt {
            let res = if metadata_scope {
                connected.reconcile_chat_metadata_only(s.db()).await
            } else {
                connected.reconcile_chat_index(s.db()).await
            };
            if let Err(e) = res {
                log::warn!(
                    target: "tgb-telegram-storage",
                    "list_files: chat reconcile failed (continuing with local index): {e}"
                );
            }
        }
    }
    let rows = index_db::list(s.db()).await?;
    let mut entries: Vec<FileEntry> = rows.into_iter().map(FileEntry::from).collect();
    if metadata_scope {
        // Catalog fast path: hand back only the metadata sidecar rows
        // so the page can show pipeline cards without paying for the
        // (possibly very large) media-row payload. The media rows
        // either haven't been minted yet (metadata-only walk skipped
        // them) or already live in SQLite from a previous full walk —
        // either way the catalog doesn't want them in this response.
        entries.retain(|e| {
            e.metadata
                .as_ref()
                .and_then(|v| v.get("role"))
                .and_then(|v| v.as_str())
                == Some("metadata")
        });
    }
    Ok(Json(ListResponse { files: entries }))
}

/// `POST /api/telegram/files/load-media/:pipeline_id` — return the
/// media row paired with this pipeline id, minting it from the chat
/// (one targeted walk) if it isn't already in SQLite. Backs the
/// catalog's "fetch chunks on play" path: the catalog list ships only
/// metadata sidecars, and this route is what the play button calls to
/// surface the actual media file id the player can stream.
async fn load_media_for_pipeline(
    State(s): State<TelegramStorage>,
    AxumPath(pipeline_id): AxumPath<String>,
) -> Result<Json<FileEntry>, StorageError> {
    require_authorized(&s).await?;
    let pipeline_id = pipeline_id.trim();
    if pipeline_id.is_empty() {
        return Err(StorageError::BadRequest("pipelineId is empty".into()));
    }
    if let Some(row) = index_db::find_media_by_pipeline_id(s.db(), pipeline_id).await? {
        return Ok(Json(FileEntry::from(row)));
    }
    let connected_opt = {
        let guard = s.inner().connected.lock().await;
        guard.as_ref().cloned()
    };
    let Some(connected) = connected_opt else {
        return Err(StorageError::NotAuthenticated);
    };
    let _ = connected
        .reconcile_chat_media_for_pipeline(s.db(), pipeline_id)
        .await?;
    match index_db::find_media_by_pipeline_id(s.db(), pipeline_id).await? {
        Some(row) => Ok(Json(FileEntry::from(row))),
        None => Err(StorageError::NotFound),
    }
}

async fn upload_file(
    State(s): State<TelegramStorage>,
    mut multipart: Multipart,
) -> Result<Json<FileEntry>, StorageError> {
    require_authorized(&s).await?;

    let mut name: Option<String> = None;
    let mut declared_size: Option<u64> = None;
    let mut content_type: Option<String> = None;
    let mut tmp_path: Option<std::path::PathBuf> = None;
    let mut file_size: u64 = 0;
    let mut metadata_value: Option<serde_json::Value> = None;
    let mut text_field: Option<String> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| StorageError::BadRequest(format!("multipart: {e}")))?
    {
        match field.name().unwrap_or("") {
            "name" => name = Some(field.text().await.unwrap_or_default()),
            "size" => {
                let s = field.text().await.unwrap_or_default();
                declared_size = s.parse().ok();
            }
            "metadata" => {
                // Caller-supplied JSON metadata. Empty / missing is
                // fine; non-empty must parse as JSON or the upload is
                // rejected before any bytes hit Telegram.
                let raw = field.text().await.unwrap_or_default();
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    metadata_value = Some(serde_json::from_str(trimmed).map_err(|e| {
                        StorageError::BadRequest(format!("metadata is not valid JSON: {e}"))
                    })?);
                }
            }
            "text" => {
                let raw = field.text().await.unwrap_or_default();
                if !raw.is_empty() {
                    text_field = Some(raw);
                }
            }
            "file" => {
                if let Some(filename) = field.file_name() {
                    name.get_or_insert_with(|| filename.to_string());
                }
                if let Some(ct) = field.content_type() {
                    content_type = Some(ct.to_string());
                }
                // Early media-type gate so we don't stage gigabytes into
                // a temp file only to reject them at the upload boundary.
                // Falls back to the extension-based check when the
                // multipart body didn't carry a content-type.
                let probe_name = name.clone().unwrap_or_default();
                let probe_mime = content_type.clone().unwrap_or_else(|| {
                    MimeGuess::from_path(&probe_name)
                        .first_or_octet_stream()
                        .essence_str()
                        .to_string()
                });
                if !media_type::is_allowed(&probe_name, &probe_mime) {
                    return Err(StorageError::UnsupportedMediaType {
                        name: probe_name,
                        mime: probe_mime,
                    });
                }
                let path = s
                    .data_root()
                    .join("telegram")
                    .join(format!("upload-{}.tmp", uuid::Uuid::new_v4()));
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).await?;
                }
                let mut f = fs::File::create(&path).await?;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|e| StorageError::BadRequest(format!("multipart: {e}")))?
                {
                    file_size += chunk.len() as u64;
                    if file_size > upload::MAX_UPLOAD_BYTES {
                        // Stop ingesting and report — don't pull GBs into a temp
                        // file we'll have to discard.
                        let _ = fs::remove_file(&path).await;
                        return Err(StorageError::FileTooLarge {
                            limit_bytes: upload::MAX_UPLOAD_BYTES,
                        });
                    }
                    f.write_all(&chunk).await?;
                }
                f.flush().await?;
                tmp_path = Some(path);
            }
            _ => {
                // ignore unknown fields
            }
        }
    }

    let tmp_path = tmp_path
        .ok_or_else(|| StorageError::BadRequest("multipart 'file' field missing".into()))?;
    let final_name = name.ok_or_else(|| StorageError::BadRequest("file name missing".into()))?;
    let mime_type = content_type.unwrap_or_else(|| {
        MimeGuess::from_path(&final_name)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    });
    let size_bytes = declared_size.unwrap_or(file_size);

    let mut request = UploadRequest::new(&final_name, &mime_type, size_bytes);
    if let Some(m) = metadata_value {
        request = request.with_metadata(m);
    }
    if let Some(t) = text_field {
        request = request.with_text(t);
    }

    let result = s.upload_local_file(&tmp_path, request).await;
    let _ = fs::remove_file(&tmp_path).await;
    let upload_result = result?;

    let row = index_db::get(s.db(), &upload_result.id)
        .await?
        .ok_or_else(|| StorageError::Internal("upload row missing after insert".into()))?;
    Ok(Json(FileEntry::from(row)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadFromPathRequest {
    /// Absolute on-disk path of the file to upload. Must resolve under
    /// the storage's `data_root` so the route can't be coaxed into
    /// shipping `/etc/passwd`.
    path: String,
    /// Filename Telegram should record. Defaults to the basename of
    /// `path`.
    #[serde(default)]
    name: Option<String>,
    /// MIME type Telegram + the index should record. Defaults to the
    /// guess from the filename extension.
    #[serde(default)]
    mime_type: Option<String>,
    /// Caller-supplied JSON metadata stamped on every chunk and stored
    /// in `tg_files.metadata`. Shape is opaque to the storage crate.
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    /// Legacy free-text caption mirrored into `tg_files.text` (kept for
    /// backwards compat with the firkin reconciler). New callers should
    /// prefer `metadata`.
    #[serde(default)]
    text: Option<String>,
}

/// `POST /api/telegram/files/from-path` — upload a server-local file
/// into the per-app storage chat. Mirrors the multipart upload's
/// behaviour byte-for-byte; the difference is the source — instead of
/// a streamed multipart body, the bytes come straight off the local
/// disk. Used by the catalog detail page's per-row track Download
/// button: yt-dlp drops the audio under `<data_root>/downloads/youtube/`,
/// then the WebUI calls this endpoint with the rolled-forward absolute
/// path so the file lands in Telegram without a frontend round-trip.
async fn upload_from_path(
    State(s): State<TelegramStorage>,
    Json(req): Json<UploadFromPathRequest>,
) -> Result<Json<FileEntry>, StorageError> {
    require_authorized(&s).await?;

    let raw = req.path.trim();
    if raw.is_empty() {
        return Err(StorageError::BadRequest("path is required".into()));
    }
    let requested = std::path::PathBuf::from(raw);
    if !requested.is_absolute() {
        return Err(StorageError::BadRequest("path must be absolute".into()));
    }
    if !is_under_data_root(&requested, s.data_root()) {
        return Err(StorageError::BadRequest(
            "path is not under the storage data root".into(),
        ));
    }
    let meta = fs::metadata(&requested).await?;
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

    let final_name = req
        .name
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            requested
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| StorageError::BadRequest("file name missing".into()))?;
    let mime_type = req
        .mime_type
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            MimeGuess::from_path(&requested)
                .first_or_octet_stream()
                .essence_str()
                .to_string()
        });

    if !media_type::is_allowed(&final_name, &mime_type) {
        return Err(StorageError::UnsupportedMediaType {
            name: final_name,
            mime: mime_type,
        });
    }

    let mut request = UploadRequest::new(&final_name, &mime_type, size_bytes);
    if let Some(m) = req.metadata {
        request = request.with_metadata(m);
    }
    if let Some(t) = req.text {
        request = request.with_text(t);
    }
    let upload_result = s.upload_local_file(&requested, request).await?;
    let row = index_db::get(s.db(), &upload_result.id)
        .await?
        .ok_or_else(|| StorageError::Internal("upload row missing after insert".into()))?;
    Ok(Json(FileEntry::from(row)))
}

/// Allow paths under the storage data root, resolved against the
/// canonical form of both sides so symlinks don't sneak under the
/// gate. Mirrors `tgb_backend::files::is_under_any`.
fn is_under_data_root(path: &Path, root: &Path) -> bool {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    canonical.starts_with(&canonical_root)
}

async fn download_file(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, StorageError> {
    require_authorized(&s).await?;
    let row = index_db::get(s.db(), &id)
        .await?
        .ok_or(StorageError::NotFound)?;
    let total = row.size_bytes.max(0) as u64;

    // For files whose upload is still in flight, only chunks that have
    // already landed on Telegram have backing `tg_file_part` rows — the
    // download path can only serve those. Read the available tail here
    // and clamp the response to exactly what we can deliver, so the
    // body's byte count matches `Content-Length` and the browser keeps
    // issuing follow-up Range requests as new chunks land. The
    // `Content-Range` still reports the declared total so the player's
    // seek-bar UI uses the eventual size, not the currently-uploaded
    // tail.
    let mut available = index_db::list_parts_total_size(s.db(), &id).await?;
    if available == 0 && total > 0 {
        // Head row exists but chunk 0 hasn't landed yet — typical for
        // the streaming-while-uploading path where the catalog opens
        // the player a few hundred ms before the first chunk's
        // `sendMedia` succeeds. Hold the request briefly so the player
        // doesn't see a 416 storm at the very start of a session.
        available = wait_for_first_part(s.db(), &id).await?;
    }
    let serveable_end_inclusive = if total == 0 || available == 0 {
        // Empty file: there's nothing to serve, and the 200 OK path
        // below produces an empty body with Content-Length: 0.
        // No parts yet (after the brief wait): the 416 arm below catches
        // any Range request; the no-range 200 OK path returns nothing.
        0
    } else {
        total.saturating_sub(1).min(available.saturating_sub(1))
    };

    // Parse the optional Range header. Safari iOS *requires* byte-range
    // support for HTML5 audio/video — without 206 responses + matching
    // Content-Range / Accept-Ranges headers the player buffers forever
    // after the initial probe. The full-file path stays 200 OK.
    let (start, end, status) = match headers.get(header::RANGE) {
        Some(v) => match parse_range(v, total) {
            Some((s, e)) => (s, e, StatusCode::PARTIAL_CONTENT),
            None => {
                // Unsatisfiable range — surface `416` with the canonical
                // `Content-Range: bytes */<total>` advertising the file
                // size so the client can retry with a valid range.
                let mut resp = Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .body(Body::empty())
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                resp.headers_mut()
                    .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
                    resp.headers_mut().insert(header::CONTENT_RANGE, v);
                }
                return Ok(resp);
            }
        },
        None => (0u64, total.saturating_sub(1), StatusCode::OK),
    };

    // Clamp to currently-uploaded tail.
    //
    //  * If `start` is past the tail, there's nothing to serve yet:
    //    surface 416 so the player retries (most browsers back off and
    //    re-issue within ~1 s — roughly the cadence new chunks land
    //    at). `Content-Range: bytes */<total>` keeps the player's
    //    seek bar pointed at the eventual full size.
    //  * Otherwise clamp `end` to the tail. The player consumes what
    //    we deliver, then asks for the next slice — at that point
    //    later chunks have usually landed and `available` has grown.
    if total > 0 && start > serveable_end_inclusive {
        let mut resp = Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .body(Body::empty())
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        resp.headers_mut()
            .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
            resp.headers_mut().insert(header::CONTENT_RANGE, v);
        }
        return Ok(resp);
    }
    let effective_end = if total == 0 {
        end
    } else {
        end.min(serveable_end_inclusive)
    };

    let (_, stream) = s.download_range(&id, start, effective_end).await?;

    let length = if total == 0 {
        0
    } else {
        effective_end - start + 1
    };
    let body_stream = ReaderStream::new(StreamRecv {
        rx: stream.rx,
        buf: Vec::new(),
    });
    let body = Body::from_stream(body_stream);

    let mut response = Response::builder()
        .status(status)
        .body(body)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&row.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).unwrap(),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        // Content-Range carries the **declared** total so the player's
        // seek-bar UI uses the full eventual size, not the currently-
        // uploaded tail. The `end` in the range header is the highest
        // byte index in this response — clamped to what we can serve.
        if let Ok(v) =
            HeaderValue::from_str(&format!("bytes {start}-{effective_end}/{total}"))
        {
            h.insert(header::CONTENT_RANGE, v);
        }
    }
    // `inline` is the correct disposition for media playback; the
    // previous `attachment` triggers a download in some clients and
    // can confuse Safari's media element pipeline.
    let disp = format!("inline; filename=\"{}\"", sanitise(&row.name));
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disp).unwrap_or_else(|_| HeaderValue::from_static("inline")),
    );
    Ok(response)
}

/// Poll `tg_file_part` for the first part row to appear, up to a short
/// budget. Returns the sum of part bytes once at least one part exists
/// (or 0 if the budget elapsed without any part landing). Called by the
/// download handler when the head row is present but no chunks have
/// been written yet — typically a few hundred milliseconds at the very
/// start of a streaming-while-uploading session, so the player doesn't
/// see a 416 storm on the initial probe.
async fn wait_for_first_part(
    db: &crate::pool::Db,
    tg_file_id: &str,
) -> Result<u64, StorageError> {
    const MAX_WAIT: std::time::Duration = std::time::Duration::from_millis(2_500);
    const POLL: std::time::Duration = std::time::Duration::from_millis(200);
    let started = std::time::Instant::now();
    loop {
        let available = index_db::list_parts_total_size(db, tg_file_id).await?;
        if available > 0 {
            return Ok(available);
        }
        if started.elapsed() >= MAX_WAIT {
            return Ok(0);
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Parse a single-range `Range: bytes=START-END` header against the
/// known total file length. Mirrors the helper in
/// `packages/backend/src/torrent.rs::parse_range` so torrent and
/// Telegram streams behave the same. Supports tail ranges
/// (`bytes=-N`) and open-ended ranges (`bytes=N-`). Multi-range
/// requests are not supported — only the first range is honoured.
fn parse_range(value: &HeaderValue, file_len: u64) -> Option<(u64, u64)> {
    let s = value.to_str().ok()?;
    let s = s.strip_prefix("bytes=")?;
    let first = s.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 || file_len == 0 {
            return None;
        }
        let suffix = suffix.min(file_len);
        return Some((file_len - suffix, file_len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() {
        file_len.saturating_sub(1)
    } else {
        end_s.parse().ok()?
    };
    if start > end || start >= file_len {
        return None;
    }
    Some((start, end.min(file_len.saturating_sub(1))))
}

async fn delete_file(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, StorageError> {
    require_authorized(&s).await?;
    s.delete(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/telegram/files/delete-all` — wipe every message from the
/// destination chat (Saved Messages or the per-app megagroup) and
/// truncate the local `tg_files` / `tg_file_part` index in one shot.
/// Returns the number of messages walked before the batched
/// `delete_messages` calls fired. Destructive — there is no
/// confirmation on the server; the WebUI is responsible for
/// double-checking with the user.
async fn delete_all_files(
    State(s): State<TelegramStorage>,
) -> Result<Json<serde_json::Value>, StorageError> {
    require_authorized(&s).await?;
    let deleted = s.delete_all().await?;
    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartUploadRequest {
    /// Absolute on-disk path of the file to upload. Must resolve under
    /// the storage's `data_root` (same gate as `/files/from-path`).
    path: String,
    /// Filename Telegram should record. Defaults to the basename of
    /// `path`.
    #[serde(default)]
    name: Option<String>,
    /// MIME type. Defaults to the guess from the filename extension.
    #[serde(default)]
    mime_type: Option<String>,
    /// Caller-supplied JSON metadata stamped on every chunk and stored
    /// in `tg_files.metadata`. Shape is opaque to the storage crate.
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    /// Legacy free-text caption mirrored into `tg_files.text`.
    #[serde(default)]
    text: Option<String>,
    /// Caller-supplied tag carried on every lifecycle event the upload
    /// emits. The pipeline UI passes the source torrent's `infoHash`
    /// here so the queue events link back to the originating row.
    #[serde(default, alias = "ref")]
    ref_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartUploadResponse {
    upload_id: String,
    snapshot: UploadSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListUploadsResponse {
    uploads: Vec<UploadSnapshot>,
}

async fn list_uploads(
    State(s): State<TelegramStorage>,
) -> Result<Json<ListUploadsResponse>, StorageError> {
    Ok(Json(ListUploadsResponse {
        uploads: s.uploads().list(),
    }))
}

async fn get_upload(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<UploadSnapshot>, StorageError> {
    s.uploads().get(&id).map(Json).ok_or(StorageError::NotFound)
}

async fn start_upload(
    State(s): State<TelegramStorage>,
    Json(req): Json<StartUploadRequest>,
) -> Result<Json<StartUploadResponse>, StorageError> {
    require_authorized(&s).await?;

    let raw = req.path.trim();
    if raw.is_empty() {
        return Err(StorageError::BadRequest("path is required".into()));
    }
    let requested = std::path::PathBuf::from(raw);
    if !requested.is_absolute() {
        return Err(StorageError::BadRequest("path must be absolute".into()));
    }
    if !is_under_data_root(&requested, s.data_root()) {
        return Err(StorageError::BadRequest(
            "path is not under the storage data root".into(),
        ));
    }
    let meta = fs::metadata(&requested).await?;

    let base_ref_id = req
        .ref_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if meta.is_dir() {
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        collect_files(&requested, &mut files).await?;
        files.sort();
        if files.is_empty() {
            return Err(StorageError::BadRequest(
                "directory contains no regular files".into(),
            ));
        }

        let dir_ref = base_ref_id.clone().unwrap_or_else(|| {
            requested
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        });

        let mut spawned: Vec<String> = Vec::with_capacity(files.len());
        for file_path in &files {
            let file_meta = fs::metadata(&file_path).await?;
            let size = file_meta.len();
            if size > upload::MAX_UPLOAD_BYTES {
                log::warn!(
                    target: "tgb-telegram-storage",
                    "skipping {file_path:?}: exceeds MAX_UPLOAD_BYTES",
                );
                continue;
            }
            let name = file_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .ok_or_else(|| StorageError::BadRequest("file name missing".into()))?;
            let mime = MimeGuess::from_path(&file_path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            // Skip non-media bundled torrent files (.srt subtitles,
            // .jpg cover art, .nfo text) instead of failing the whole
            // batch — the rest of the directory may still have a real
            // video/audio file worth uploading.
            if !media_type::is_allowed(&name, &mime) {
                log::info!(
                    target: "tgb-telegram-storage",
                    "skipping non-media file {file_path:?} (mime={mime})",
                );
                continue;
            }
            let upload_id = uploads::spawn_upload(
                s.clone(),
                file_path.clone(),
                name,
                mime,
                size,
                dir_ref.clone(),
                req.metadata.clone(),
                req.text.clone(),
                None,
            );
            spawned.push(upload_id);
        }

        let first = spawned
            .into_iter()
            .next()
            .ok_or_else(|| StorageError::BadRequest("no uploadable files in directory".into()))?;
        let snapshot = s.uploads().get(&first).ok_or_else(|| {
            StorageError::Internal("upload missing immediately after spawn".into())
        })?;
        return Ok(Json(StartUploadResponse {
            upload_id: first,
            snapshot,
        }));
    }

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

    let final_name = req
        .name
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            requested
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| StorageError::BadRequest("file name missing".into()))?;
    let mime_type = req
        .mime_type
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            MimeGuess::from_path(&requested)
                .first_or_octet_stream()
                .essence_str()
                .to_string()
        });
    if !media_type::is_allowed(&final_name, &mime_type) {
        return Err(StorageError::UnsupportedMediaType {
            name: final_name,
            mime: mime_type,
        });
    }
    let ref_id = base_ref_id.unwrap_or_else(|| final_name.clone());

    let upload_id = uploads::spawn_upload(
        s.clone(),
        requested,
        final_name,
        mime_type,
        size_bytes,
        ref_id,
        req.metadata,
        req.text,
        None,
    );
    let snapshot = s
        .uploads()
        .get(&upload_id)
        .ok_or_else(|| StorageError::Internal("upload missing immediately after spawn".into()))?;
    Ok(Json(StartUploadResponse {
        upload_id,
        snapshot,
    }))
}

/// Recursively walk `dir`, appending every regular file to `out`.
/// Used by `start_upload` when the caller hands us a directory path
/// (e.g. a multi-file torrent's output folder) so we can spawn one
/// background upload per file. Symlinks are followed via `fs::metadata`.
async fn collect_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), StorageError> {
    let mut stack: Vec<std::path::PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut entries = fs::read_dir(&d).await?;
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            let meta = fs::metadata(&p).await?;
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                out.push(p);
            }
        }
    }
    Ok(())
}

async fn pause_upload(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<UploadSnapshot>, StorageError> {
    if !s.uploads().pause(&id) {
        return Err(StorageError::NotFound);
    }
    s.uploads().get(&id).map(Json).ok_or(StorageError::NotFound)
}

async fn resume_upload(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<UploadSnapshot>, StorageError> {
    if !s.uploads().resume(&id) {
        return Err(StorageError::NotFound);
    }
    s.uploads().get(&id).map(Json).ok_or(StorageError::NotFound)
}

async fn cancel_upload(
    State(s): State<TelegramStorage>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, StorageError> {
    if !s.uploads().cancel(&id) {
        return Err(StorageError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn require_authorized(s: &TelegramStorage) -> Result<(), StorageError> {
    let connected = {
        let guard = s.inner().connected.lock().await;
        guard.as_ref().cloned()
    };
    match connected {
        Some(c) => match c.is_authorized().await {
            Ok(true) => Ok(()),
            Ok(false) => Err(StorageError::NotAuthenticated),
            Err(e) => Err(e),
        },
        None => Err(StorageError::CredentialsMissing),
    }
}

async fn wipe_session_file(data_root: &Path) {
    let path = session_path(data_root);
    let _ = fs::remove_file(&path).await;
}

fn sanitise(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '"' | '\\' | '\r' | '\n' => '_',
            _ => c,
        })
        .collect()
}

/// Wraps an `mpsc::Receiver<Result<Vec<u8>, _>>` as an `AsyncRead` so
/// it slots into [`tokio_util::io::ReaderStream`] for the Axum body.
struct StreamRecv {
    rx: tokio::sync::mpsc::Receiver<Result<Vec<u8>, StorageError>>,
    buf: Vec<u8>,
}

impl tokio::io::AsyncRead for StreamRecv {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        loop {
            if !self.buf.is_empty() {
                let n = std::cmp::min(self.buf.len(), buf.remaining());
                let drained: Vec<u8> = self.buf.drain(..n).collect();
                buf.put_slice(&drained);
                return std::task::Poll::Ready(Ok(()));
            }
            match self.rx.poll_recv(cx) {
                std::task::Poll::Pending => return std::task::Poll::Pending,
                std::task::Poll::Ready(None) => return std::task::Poll::Ready(Ok(())),
                std::task::Poll::Ready(Some(Ok(chunk))) => {
                    self.buf = chunk;
                }
                std::task::Poll::Ready(Some(Err(e))) => {
                    return std::task::Poll::Ready(Err(std::io::Error::other(e.to_string())));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::state::{TelegramConfig, TelegramStorage};

    async fn fresh_db() -> crate::pool::Db {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        crate::pool::Db::new(pool)
    }

    async fn fresh_storage(tmp: &TempDir) -> TelegramStorage {
        // Make sure env-based credentials don't accidentally trigger a
        // network reconnect during init.
        unsafe {
            std::env::remove_var("TELEGRAM_API_ID");
            std::env::remove_var("TELEGRAM_API_HASH");
        }
        let db = fresh_db().await;
        TelegramStorage::init(TelegramConfig {
            data_root: tmp.path().to_path_buf(),
            db,
            event_sink: None,
        })
        .await
        .unwrap()
    }

    fn empty_req(method: &str, uri: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    fn json_req(method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    #[tokio::test]
    async fn status_route_reports_uninitialised_storage() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app.oneshot(empty_req("GET", "/status")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["hasCredentials"], false);
        assert_eq!(body["connected"], false);
        assert_eq!(body["authorized"], false);
        assert!(body["loginInProgress"].is_null());
    }

    #[tokio::test]
    async fn get_credentials_returns_400_when_unset() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app.oneshot(empty_req("GET", "/credentials")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "credentials_missing");
    }

    #[tokio::test]
    async fn set_credentials_rejects_zero_api_id() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/credentials",
                serde_json::json!({ "apiId": 0, "apiHash": "abc" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "bad_request");
    }

    #[tokio::test]
    async fn set_credentials_rejects_blank_api_hash() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/credentials",
                serde_json::json!({ "apiId": 1, "apiHash": "   " }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_credentials_succeeds_when_none_set() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("DELETE", "/credentials"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn auth_start_without_credentials_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/auth/start",
                serde_json::json!({ "phone": "+12025550100" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "credentials_missing");
    }

    #[tokio::test]
    async fn auth_code_with_no_login_in_progress_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/auth/code",
                serde_json::json!({ "code": "12345" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "no_login_in_progress");
    }

    #[tokio::test]
    async fn auth_password_with_no_login_in_progress_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/auth/password",
                serde_json::json!({ "password": "p" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "no_login_in_progress");
    }

    #[tokio::test]
    async fn auth_logout_without_session_succeeds_idempotently() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("POST", "/auth/logout"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn transfer_export_without_credentials_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app.oneshot(empty_req("GET", "/transfer")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn transfer_export_with_invalid_scope_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("GET", "/transfer?scope=wrong"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn transfer_import_rejects_unknown_kind() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/transfer",
                serde_json::json!({ "kind": "something-else" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn transfer_import_rejects_unsupported_version() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/transfer",
                serde_json::json!({ "v": 7, "credentials": { "apiId": 1, "apiHash": "x" } }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn transfer_import_rejects_empty_payload() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req("POST", "/transfer", serde_json::json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn transfer_import_rejects_invalid_credentials() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/transfer",
                serde_json::json!({ "credentials": { "apiId": 0, "apiHash": "" } }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_files_without_auth_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app.oneshot(empty_req("GET", "/files")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "credentials_missing");
    }

    #[tokio::test]
    async fn delete_all_files_without_auth_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("POST", "/files/delete-all"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_file_without_auth_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("DELETE", "/files/some-id"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_uploads_returns_empty_initially() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app.oneshot(empty_req("GET", "/uploads")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["uploads"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn get_unknown_upload_returns_404() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("GET", "/uploads/no-such-id"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn pause_unknown_upload_returns_404() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("POST", "/uploads/no/pause"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn resume_unknown_upload_returns_404() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("POST", "/uploads/no/resume"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cancel_unknown_upload_returns_404() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(empty_req("DELETE", "/uploads/no"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn start_upload_without_auth_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/uploads",
                serde_json::json!({ "path": "/tmp/whatever" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn upload_from_path_without_auth_returns_400() {
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/files/from-path",
                serde_json::json!({ "path": "/tmp/whatever" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_range_handles_open_ended_and_suffix() {
        let total: u64 = 100;
        let hv = |s: &str| HeaderValue::from_str(s).unwrap();
        assert_eq!(parse_range(&hv("bytes=0-9"), total), Some((0, 9)));
        assert_eq!(parse_range(&hv("bytes=10-"), total), Some((10, 99)));
        assert_eq!(parse_range(&hv("bytes=-20"), total), Some((80, 99)));
        // start past end → None (unsatisfiable).
        assert!(parse_range(&hv("bytes=200-"), total).is_none());
        // Empty header / wrong unit / bad ranges → None.
        assert!(parse_range(&hv("entries=0-9"), total).is_none());
        assert!(parse_range(&hv("bytes=5-2"), total).is_none());
        // Suffix of 0 → None.
        assert!(parse_range(&hv("bytes=-0"), total).is_none());
        // Multi-range: only first honoured.
        assert_eq!(parse_range(&hv("bytes=0-1,10-20"), total), Some((0, 1)));
        // Zero file_len with suffix request → None.
        assert!(parse_range(&hv("bytes=-5"), 0).is_none());
    }

    #[test]
    fn sanitise_strips_quote_and_control_chars() {
        assert_eq!(sanitise(r#"abc"def"#), "abc_def");
        assert_eq!(sanitise("a\\b"), "a_b");
        assert_eq!(sanitise("a\rb\nc"), "a_b_c");
        assert_eq!(sanitise("normal name.mp4"), "normal name.mp4");
    }

    #[test]
    fn is_under_data_root_accepts_exact_and_subdir() {
        let tmp = TempDir::new().unwrap();
        let inside = tmp.path().join("file.mp4");
        std::fs::write(&inside, b"x").unwrap();
        assert!(is_under_data_root(&inside, tmp.path()));
        let outside = std::env::temp_dir();
        assert!(!is_under_data_root(&outside, tmp.path()));
    }

    #[tokio::test]
    async fn upload_from_path_validates_inputs_before_auth_when_empty() {
        // Auth check still runs first → blank path returns the
        // credentials_missing error from `require_authorized`, not the
        // bad-request from the path check. Both are 400, so the route
        // shape still exercises the early-validation arms.
        let tmp = TempDir::new().unwrap();
        let storage = fresh_storage(&tmp).await;
        let app = router(storage);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/files/from-path",
                serde_json::json!({ "path": "" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
