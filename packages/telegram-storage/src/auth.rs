//! Login state machine.
//!
//! Two- or three-step login:
//!   1. `request_code(phone)` — Telegram dispatches a code (to the official
//!      app, SMS, a call, the account's login email, …). Returns a
//!      [`CodeRequest`] plus a [`CodeDelivery`] describing *where* the code
//!      went, both held in `LoginInProgress`. `resend_code` asks Telegram to
//!      deliver it again, usually over the next method (e.g. SMS).
//!   2. `submit_code(code)` — completes login *or* surfaces a
//!      `password_required` outcome with a `PasswordToken`.
//!   3. `submit_password(password)` — only on 2FA accounts.
//!
//! Steps 1–2 invoke `auth.sendCode` / `auth.resendCode` / `auth.signIn`
//! directly instead of grammers' `request_login_code` / `sign_in`: grammers
//! discards the `auth.SentCode.type`, so the UI could never tell the user
//! where to look for the code, and its opaque `LoginToken` can't be built
//! from a resent code.
//!
//! The in-progress state is stored on the [`TelegramStorage`] under a
//! single mutex; concurrent login attempts are not supported (the
//! frontend wizard is single-page).

use grammers_client::client::PasswordToken;
use grammers_client::peer::User;
use grammers_client::{InvocationError, SignInError};
use grammers_session::types::{PeerInfo, UpdateState, UpdatesState};
use grammers_session::Session;
use grammers_tl_types as tl;
use serde::Serialize;

use crate::client::ConnectedClient;
use crate::error::StorageError;

/// In-progress login state held in the storage's `Mutex<Option<LoginInProgress>>`.
pub enum LoginInProgress {
    /// We've sent the code, waiting for the user to type it in.
    AwaitingCode {
        request: CodeRequest,
        delivery: CodeDelivery,
    },
    /// The code was correct but the account has 2FA. We're waiting
    /// for the password.
    AwaitingPassword { token: PasswordToken },
}

/// What `auth.signIn` / `auth.resendCode` need to reference a sent code.
pub struct CodeRequest {
    pub phone: String,
    pub phone_code_hash: String,
}

/// Where Telegram delivered the login code, surfaced on `GET /status` so the
/// login UI can tell the user where to look.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeDelivery {
    /// `app` | `sms` | `call` | `flash_call` | `missed_call` | `email` |
    /// `setup_email_required` | `fragment_sms` | `firebase_sms` | `sms_word` |
    /// `sms_phrase`.
    pub method: &'static str,
    /// Expected code length, when Telegram says.
    pub length: Option<i32>,
    /// Masked address the code was emailed to (`method == "email"`).
    pub email_pattern: Option<String>,
    /// Method a resend will use (`sms` | `call` | `flash_call` |
    /// `missed_call` | `fragment_sms`). `None` means no resend is offered.
    pub next_method: Option<&'static str>,
    /// Seconds before a resend is allowed.
    pub timeout_secs: Option<i32>,
}

impl CodeDelivery {
    pub fn from_sent_code(sent: &tl::types::auth::SentCode) -> Self {
        use tl::enums::auth::SentCodeType as T;
        let (method, length, email_pattern) = match &sent.r#type {
            T::App(t) => ("app", Some(t.length), None),
            T::Sms(t) => ("sms", Some(t.length), None),
            T::Call(t) => ("call", Some(t.length), None),
            T::FlashCall(_) => ("flash_call", None, None),
            T::MissedCall(t) => ("missed_call", Some(t.length), None),
            T::EmailCode(t) => ("email", Some(t.length), Some(t.email_pattern.clone())),
            T::SetUpEmailRequired(_) => ("setup_email_required", None, None),
            T::FragmentSms(t) => ("fragment_sms", Some(t.length), None),
            T::FirebaseSms(t) => ("firebase_sms", Some(t.length), None),
            T::SmsWord(_) => ("sms_word", None, None),
            T::SmsPhrase(_) => ("sms_phrase", None, None),
        };
        let next_method = sent.next_type.as_ref().map(|n| {
            use tl::enums::auth::CodeType as N;
            match n {
                N::Sms => "sms",
                N::Call => "call",
                N::FlashCall => "flash_call",
                N::MissedCall => "missed_call",
                N::FragmentSms => "fragment_sms",
            }
        });
        Self {
            method,
            length,
            email_pattern,
            next_method,
            timeout_secs: sent.timeout,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum AuthOutcome {
    /// Login complete.
    Authenticated { user: AuthUser },
    /// Code was correct but the account has 2FA. The wizard advances
    /// to the password screen.
    PasswordRequired {
        /// Optional 2FA hint string set by the user when they enabled 2FA.
        hint: Option<String>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: i64,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub phone: Option<String>,
}

impl AuthUser {
    pub fn from_user(user: &User) -> Self {
        Self {
            id: user.id().bare_id(),
            first_name: user.first_name().map(str::to_string),
            last_name: user.last_name().map(str::to_string),
            username: user.username().map(str::to_string),
            phone: user.phone().map(str::to_string),
        }
    }
}

/// Submit the phone number — Telegram sends a code and says where it went.
/// Follows a `PHONE_MIGRATE_X` (303) by switching the session's home DC and
/// retrying, the same way grammers' `request_login_code` does.
pub async fn request_code(
    connected: &ConnectedClient,
    phone: &str,
) -> Result<(CodeRequest, CodeDelivery), StorageError> {
    let request = tl::functions::auth::SendCode {
        phone_number: phone.to_string(),
        api_id: connected.api_id,
        api_hash: connected.api_hash.clone(),
        settings: tl::types::CodeSettings {
            allow_flashcall: false,
            current_number: false,
            allow_app_hash: false,
            allow_missed_call: false,
            allow_firebase: false,
            logout_tokens: None,
            token: None,
            app_sandbox: None,
            unknown_number: false,
        }
        .into(),
    };

    let sent = match connected.client.invoke(&request).await {
        Err(InvocationError::Rpc(err)) if err.code == 303 => {
            let new_dc_id = err.value.ok_or_else(|| {
                StorageError::Telegram(format!("{} without a target DC", err.name))
            })? as i32;
            switch_home_dc(connected, new_dc_id).await;
            connected.client.invoke(&request).await?
        }
        other => other?,
    };
    let sent = expect_code(sent)?;
    let delivery = CodeDelivery::from_sent_code(&sent);
    log_delivery("sent", &delivery);
    Ok((
        CodeRequest {
            phone: phone.to_string(),
            phone_code_hash: sent.phone_code_hash,
        },
        delivery,
    ))
}

/// Ask Telegram to deliver the code again — typically over
/// [`CodeDelivery::next_method`]. Returns the refreshed request (the
/// `phone_code_hash` can change) and delivery.
pub async fn resend_code(
    connected: &ConnectedClient,
    request: &CodeRequest,
) -> Result<(CodeRequest, CodeDelivery), StorageError> {
    let sent = connected
        .client
        .invoke(&tl::functions::auth::ResendCode {
            phone_number: request.phone.clone(),
            phone_code_hash: request.phone_code_hash.clone(),
            reason: None,
        })
        .await?;
    let sent = expect_code(sent)?;
    let delivery = CodeDelivery::from_sent_code(&sent);
    log_delivery("resent", &delivery);
    Ok((
        CodeRequest {
            phone: request.phone.clone(),
            phone_code_hash: sent.phone_code_hash,
        },
        delivery,
    ))
}

fn expect_code(sent: tl::enums::auth::SentCode) -> Result<tl::types::auth::SentCode, StorageError> {
    match sent {
        tl::enums::auth::SentCode::Code(code) => Ok(code),
        tl::enums::auth::SentCode::Success(_) => Err(StorageError::Telegram(
            "Telegram reported the login as already complete; restart the sign-in".into(),
        )),
        tl::enums::auth::SentCode::PaymentRequired(_) => Err(StorageError::Telegram(
            "Telegram requires a payment before it will send a login code to this number".into(),
        )),
    }
}

fn log_delivery(verb: &str, d: &CodeDelivery) {
    log::info!(
        target: "tgb-telegram-storage",
        "login code {verb} via {} (length {:?}, email {:?}, resend via {:?} after {:?}s)",
        d.method,
        d.length,
        d.email_pattern,
        d.next_method,
        d.timeout_secs
    );
}

/// Submit the code received on the user's phone. Completes the login,
/// or returns a `PasswordToken` on 2FA accounts.
///
/// On success, callers should persist the session (it auto-saves to
/// the SQLite session file via `grammers-session`).
pub enum SubmitCodeOutcome {
    Authenticated(User),
    PasswordRequired(PasswordToken),
}

pub async fn submit_code(
    connected: &ConnectedClient,
    request: &CodeRequest,
    code: &str,
) -> Result<SubmitCodeOutcome, StorageError> {
    match connected
        .client
        .invoke(&tl::functions::auth::SignIn {
            phone_number: request.phone.clone(),
            phone_code_hash: request.phone_code_hash.clone(),
            phone_code: Some(code.to_string()),
            email_verification: None,
        })
        .await
    {
        Ok(authorization) => authorization_outcome(connected, authorization).await,
        Err(err) if err.is("SESSION_PASSWORD_NEEDED") => password_required(connected).await,
        Err(err) if err.is("PHONE_CODE_*") => Err(StorageError::InvalidCode),
        Err(err) => Err(err.into()),
    }
}

/// One step of QR-code login (`auth.exportLoginToken`), for accounts whose
/// login codes never arrive. Poll it: while nobody has scanned yet it returns
/// a fresh `tg://login?token=…` URL to render as a QR; once the user approves
/// it from Telegram on their phone (Settings → Devices → Link Desktop Device)
/// the next call completes the login (or asks for the 2FA password).
pub enum QrLoginStep {
    Pending { url: String, expires_at: i32 },
    Done(SubmitCodeOutcome),
}

pub async fn qr_login_step(connected: &ConnectedClient) -> Result<QrLoginStep, StorageError> {
    use tl::enums::auth::LoginToken as T;

    let export = tl::functions::auth::ExportLoginToken {
        api_id: connected.api_id,
        api_hash: connected.api_hash.clone(),
        except_ids: Vec::new(),
    };
    let token = match connected.client.invoke(&export).await {
        Err(err) if err.is("SESSION_PASSWORD_NEEDED") => {
            return Ok(QrLoginStep::Done(password_required(connected).await?))
        }
        other => other?,
    };
    // The approving account lives on another DC: move there and redeem the
    // token, exactly like a `PHONE_MIGRATE` during code login.
    let token = match token {
        T::MigrateTo(migrate) => {
            log::info!(
                target: "tgb-telegram-storage",
                "qr login: approved from an account on DC {}, importing the token there",
                migrate.dc_id
            );
            switch_home_dc(connected, migrate.dc_id).await;
            let import = tl::functions::auth::ImportLoginToken {
                token: migrate.token,
            };
            match connected.client.invoke(&import).await {
                Err(err) if err.is("SESSION_PASSWORD_NEEDED") => {
                    return Ok(QrLoginStep::Done(password_required(connected).await?))
                }
                other => other?,
            }
        }
        other => other,
    };
    match token {
        T::Token(token) => {
            // Polled every few seconds: log once per issued token, not per poll.
            static LAST_EXPIRES: std::sync::atomic::AtomicI32 =
                std::sync::atomic::AtomicI32::new(0);
            if LAST_EXPIRES.swap(token.expires, std::sync::atomic::Ordering::Relaxed)
                != token.expires
            {
                log::info!(
                    target: "tgb-telegram-storage",
                    "qr login: showing a new QR, waiting for approval (expires at {})",
                    token.expires
                );
            }
            Ok(QrLoginStep::Pending {
                url: format!("tg://login?token={}", base64url(&token.token)),
                expires_at: token.expires,
            })
        }
        T::Success(success) => {
            log::info!(target: "tgb-telegram-storage", "qr login: approved, completing sign-in");
            Ok(QrLoginStep::Done(
                authorization_outcome(connected, success.authorization).await?,
            ))
        }
        T::MigrateTo(_) => Err(StorageError::Telegram(
            "QR login asked to switch data centers twice".into(),
        )),
    }
}

async fn switch_home_dc(connected: &ConnectedClient, new_dc_id: i32) {
    let old_dc_id = connected.session.home_dc_id();
    if old_dc_id == new_dc_id {
        return;
    }
    log::info!(
        target: "tgb-telegram-storage",
        "login: account lives on DC {new_dc_id} (was {old_dc_id}), switching"
    );
    connected.pool_handle.disconnect_from_dc(old_dc_id);
    connected.session.set_home_dc_id(new_dc_id).await;
}

async fn authorization_outcome(
    connected: &ConnectedClient,
    authorization: tl::enums::auth::Authorization,
) -> Result<SubmitCodeOutcome, StorageError> {
    match authorization {
        tl::enums::auth::Authorization::Authorization(auth) => Ok(
            SubmitCodeOutcome::Authenticated(complete_login(connected, auth).await?),
        ),
        tl::enums::auth::Authorization::SignUpRequired(_) => Err(StorageError::Telegram(
            "sign up with the official Telegram app required".into(),
        )),
    }
}

async fn password_required(connected: &ConnectedClient) -> Result<SubmitCodeOutcome, StorageError> {
    let password: tl::types::account::Password = connected
        .client
        .invoke(&tl::functions::account::GetPassword {})
        .await?
        .into();
    Ok(SubmitCodeOutcome::PasswordRequired(PasswordToken::new(
        password,
    )))
}

/// Unpadded URL-safe base64, the encoding `tg://login?token=` expects.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 0x3f) as usize] as char);
        }
    }
    out
}

/// Mirror of grammers' private `Client::complete_login`: record the signed-in
/// user as `self` in the session (that's what makes later `is_authorized` /
/// `get_me` work) and seed the update state.
async fn complete_login(
    connected: &ConnectedClient,
    auth: tl::types::auth::Authorization,
) -> Result<User, StorageError> {
    let update_state = connected
        .client
        .invoke(&tl::functions::updates::GetState {})
        .await
        .ok();

    let user = User::from_raw(&connected.client, auth.user);
    let peer_auth = user
        .to_ref()
        .await
        .ok_or_else(|| StorageError::Internal("signed-in user has no peer reference".into()))?
        .auth;
    connected
        .session
        .cache_peer(&PeerInfo::User {
            id: user.id().bare_id(),
            auth: Some(peer_auth),
            bot: Some(user.is_bot()),
            is_self: Some(true),
        })
        .await;
    if let Some(tl::enums::updates::State::State(state)) = update_state {
        connected
            .session
            .set_update_state(UpdateState::All(UpdatesState {
                pts: state.pts,
                qts: state.qts,
                date: state.date,
                seq: state.seq,
                channels: Vec::new(),
            }))
            .await;
    }
    Ok(user)
}

pub async fn submit_password(
    connected: &ConnectedClient,
    token: PasswordToken,
    password: &str,
) -> Result<User, StorageError> {
    match connected
        .client
        .check_password(token, password.as_bytes())
        .await
    {
        Ok(user) => Ok(user),
        Err(SignInError::InvalidPassword(_)) => Err(StorageError::InvalidPassword),
        Err(SignInError::Other(e)) => Err(e.into()),
        Err(other) => Err(StorageError::Telegram(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(r#type: tl::enums::auth::SentCodeType) -> tl::types::auth::SentCode {
        tl::types::auth::SentCode {
            r#type,
            phone_code_hash: "hash".into(),
            next_type: Some(tl::enums::auth::CodeType::Sms),
            timeout: Some(60),
        }
    }

    #[test]
    fn base64url_matches_rfc4648_vectors() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        // URL-safe alphabet: 0xfb 0xff → "-_8" rather than "+/8".
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn delivery_reports_app_with_sms_fallback() {
        let d = CodeDelivery::from_sent_code(&sent(
            tl::types::auth::SentCodeTypeApp { length: 5 }.into(),
        ));
        assert_eq!(d.method, "app");
        assert_eq!(d.length, Some(5));
        assert_eq!(d.next_method, Some("sms"));
        assert_eq!(d.timeout_secs, Some(60));
    }

    #[test]
    fn delivery_reports_email_pattern() {
        let d = CodeDelivery::from_sent_code(&sent(
            tl::types::auth::SentCodeTypeEmailCode {
                apple_signin_allowed: false,
                google_signin_allowed: false,
                email_pattern: "b***@gmail.com".into(),
                length: 6,
                reset_available_period: None,
                reset_pending_date: None,
            }
            .into(),
        ));
        assert_eq!(d.method, "email");
        assert_eq!(d.email_pattern.as_deref(), Some("b***@gmail.com"));
    }

    #[test]
    fn delivery_reports_setup_email_required() {
        let d = CodeDelivery::from_sent_code(&sent(
            tl::types::auth::SentCodeTypeSetUpEmailRequired {
                apple_signin_allowed: false,
                google_signin_allowed: false,
            }
            .into(),
        ));
        assert_eq!(d.method, "setup_email_required");
        assert_eq!(d.length, None);
    }
}
