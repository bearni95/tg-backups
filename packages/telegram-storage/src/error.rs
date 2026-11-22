//! Storage-wide error type. Every public route maps `Result<T,
//! StorageError>` → JSON via `IntoResponse`. The frontend reads `error`
//! and `code` to localise messages.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("not authenticated")]
    NotAuthenticated,
    #[error("api credentials not configured")]
    CredentialsMissing,
    #[error("login already in progress for a different phone")]
    LoginInProgressMismatch,
    #[error("no login in progress")]
    NoLoginInProgress,
    #[error("password required")]
    PasswordRequired,
    #[error("invalid code")]
    InvalidCode,
    #[error("invalid password")]
    InvalidPassword,
    #[error("file too large: {limit_bytes} byte limit")]
    FileTooLarge { limit_bytes: u64 },
    #[error(
        "unsupported file type for {name:?} (mime={mime}); only .zip backups are accepted"
    )]
    UnsupportedMediaType { name: String, mime: String },
    #[error("file not found")]
    NotFound,
    #[error("checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },
    #[error("backup is incomplete; upload the same zip again to finish it")]
    BackupIncomplete,
    #[error("upload aborted by caller")]
    UploadAborted,
    #[error("rate limited; retry after {retry_after_seconds}s")]
    RateLimited { retry_after_seconds: u64 },
    #[error("telegram error: {0}")]
    Telegram(String),
    #[error("database error: {0}")]
    Database(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl StorageError {
    fn code(&self) -> &'static str {
        match self {
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialsMissing => "credentials_missing",
            Self::LoginInProgressMismatch => "login_in_progress_mismatch",
            Self::NoLoginInProgress => "no_login_in_progress",
            Self::PasswordRequired => "password_required",
            Self::InvalidCode => "invalid_code",
            Self::InvalidPassword => "invalid_password",
            Self::FileTooLarge { .. } => "file_too_large",
            Self::UnsupportedMediaType { .. } => "unsupported_media_type",
            Self::BackupIncomplete => "backup_incomplete",
            Self::NotFound => "not_found",
            Self::ChecksumMismatch { .. } => "checksum_mismatch",
            Self::UploadAborted => "upload_aborted",
            Self::RateLimited { .. } => "rate_limited",
            Self::Telegram(_) => "telegram_error",
            Self::Database(_) => "database_error",
            Self::Io(_) => "io_error",
            Self::BadRequest(_) => "bad_request",
            Self::Internal(_) => "internal",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::NotAuthenticated | Self::PasswordRequired => StatusCode::UNAUTHORIZED,
            Self::CredentialsMissing
            | Self::NoLoginInProgress
            | Self::LoginInProgressMismatch
            | Self::InvalidCode
            | Self::InvalidPassword
            | Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::FileTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType { .. } => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::BackupIncomplete => StatusCode::CONFLICT,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::ChecksumMismatch { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            Self::UploadAborted => StatusCode::CONFLICT,
            Self::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for StorageError {
    fn into_response(self) -> Response {
        let status = self.status();
        let mut payload = json!({
            "error": self.to_string(),
            "code": self.code(),
        });
        if let Self::RateLimited {
            retry_after_seconds,
        } = &self
        {
            payload["retryAfterSeconds"] = json!(retry_after_seconds);
        }
        if let Self::FileTooLarge { limit_bytes } = &self {
            payload["limitBytes"] = json!(limit_bytes);
        }
        if let Self::UnsupportedMediaType { name, mime } = &self {
            payload["name"] = json!(name);
            payload["mime"] = json!(mime);
        }
        (status, Json(payload)).into_response()
    }
}

impl From<sqlx::Error> for StorageError {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e.to_string())
    }
}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        Self::Internal(format!("json: {e}"))
    }
}

impl From<grammers_client::InvocationError> for StorageError {
    fn from(e: grammers_client::InvocationError) -> Self {
        if let grammers_client::InvocationError::Rpc(rpc) = &e {
            // FloodWait gets the retry hint so the UI can render a sensible
            // toast instead of "telegram error: …".
            if rpc.name == "FLOOD_WAIT" || rpc.name.starts_with("FLOOD_") {
                if let Some(secs) = rpc.value {
                    return Self::RateLimited {
                        retry_after_seconds: secs as u64,
                    };
                }
            }
            // Server-side session-kill errors. Without this branch they
            // fall through to `Telegram(_)` which maps to 500, and the
            // frontend can't tell a transient backend bug from "your
            // session was revoked, sign in again". `AUTH_KEY_UNREGISTERED`
            // is what Telegram returns after a remote logout (Settings →
            // Devices → Terminate on another device) and after long
            // periods of inactivity that purge the session server-side.
            if matches!(
                rpc.name.as_str(),
                "AUTH_KEY_UNREGISTERED"
                    | "AUTH_KEY_INVALID"
                    | "AUTH_KEY_PERM_EMPTY"
                    | "SESSION_EXPIRED"
                    | "SESSION_REVOKED"
                    | "USER_DEACTIVATED"
                    | "USER_DEACTIVATED_BAN"
            ) {
                return Self::NotAuthenticated;
            }
        }
        Self::Telegram(e.to_string())
    }
}

impl From<anyhow::Error> for StorageError {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[test]
    fn codes_cover_every_variant() {
        let cases = [
            (StorageError::NotAuthenticated, "not_authenticated"),
            (StorageError::CredentialsMissing, "credentials_missing"),
            (
                StorageError::LoginInProgressMismatch,
                "login_in_progress_mismatch",
            ),
            (StorageError::NoLoginInProgress, "no_login_in_progress"),
            (StorageError::PasswordRequired, "password_required"),
            (StorageError::InvalidCode, "invalid_code"),
            (StorageError::InvalidPassword, "invalid_password"),
            (
                StorageError::FileTooLarge { limit_bytes: 10 },
                "file_too_large",
            ),
            (
                StorageError::UnsupportedMediaType {
                    name: "x".into(),
                    mime: "y".into(),
                },
                "unsupported_media_type",
            ),
            (StorageError::NotFound, "not_found"),
            (
                StorageError::ChecksumMismatch {
                    expected: "a".into(),
                    actual: "b".into(),
                },
                "checksum_mismatch",
            ),
            (StorageError::UploadAborted, "upload_aborted"),
            (
                StorageError::RateLimited {
                    retry_after_seconds: 3,
                },
                "rate_limited",
            ),
            (StorageError::Telegram("x".into()), "telegram_error"),
            (StorageError::Database("x".into()), "database_error"),
            (StorageError::Io("x".into()), "io_error"),
            (StorageError::BadRequest("x".into()), "bad_request"),
            (StorageError::Internal("x".into()), "internal"),
        ];
        for (err, expected) in cases {
            assert_eq!(err.code(), expected);
        }
    }

    #[test]
    fn statuses_map_correctly() {
        assert_eq!(
            StorageError::NotAuthenticated.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            StorageError::PasswordRequired.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            StorageError::CredentialsMissing.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            StorageError::NoLoginInProgress.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            StorageError::LoginInProgressMismatch.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(StorageError::InvalidCode.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            StorageError::InvalidPassword.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            StorageError::BadRequest("x".into()).status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            StorageError::FileTooLarge { limit_bytes: 1 }.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            StorageError::UnsupportedMediaType {
                name: "a".into(),
                mime: "b".into()
            }
            .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(StorageError::NotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            StorageError::ChecksumMismatch {
                expected: "x".into(),
                actual: "y".into()
            }
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(StorageError::UploadAborted.status(), StatusCode::CONFLICT);
        assert_eq!(
            StorageError::RateLimited {
                retry_after_seconds: 1
            }
            .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            StorageError::Telegram("x".into()).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            StorageError::Database("x".into()).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            StorageError::Io("x".into()).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            StorageError::Internal("x".into()).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[tokio::test]
    async fn into_response_serialises_rate_limited_with_retry_after() {
        let err = StorageError::RateLimited {
            retry_after_seconds: 12,
        };
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "rate_limited");
        assert_eq!(v["retryAfterSeconds"], 12);
    }

    #[tokio::test]
    async fn into_response_serialises_file_too_large_with_limit() {
        let err = StorageError::FileTooLarge { limit_bytes: 999 };
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "file_too_large");
        assert_eq!(v["limitBytes"], 999);
    }

    #[tokio::test]
    async fn into_response_serialises_unsupported_media_type_with_name_mime() {
        let err = StorageError::UnsupportedMediaType {
            name: "cover.jpg".into(),
            mime: "image/jpeg".into(),
        };
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], "unsupported_media_type");
        assert_eq!(v["name"], "cover.jpg");
        assert_eq!(v["mime"], "image/jpeg");
    }

    #[test]
    fn from_io_error_maps_to_io_variant() {
        let io = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        let e: StorageError = io.into();
        assert!(matches!(e, StorageError::Io(_)));
    }

    #[test]
    fn from_json_error_maps_to_internal_variant() {
        let json_err = serde_json::from_str::<serde_json::Value>("not json").unwrap_err();
        let e: StorageError = json_err.into();
        assert!(matches!(e, StorageError::Internal(_)));
    }

    #[test]
    fn from_anyhow_error_maps_to_internal_variant() {
        let any: anyhow::Error = anyhow::anyhow!("oops");
        let e: StorageError = any.into();
        assert!(matches!(e, StorageError::Internal(_)));
    }

    #[test]
    fn display_includes_payload() {
        let e = StorageError::Telegram("network".into());
        assert!(e.to_string().contains("network"));
        let e = StorageError::ChecksumMismatch {
            expected: "abc".into(),
            actual: "def".into(),
        };
        let s = e.to_string();
        assert!(s.contains("abc"));
        assert!(s.contains("def"));
    }
}
