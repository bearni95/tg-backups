//! User-supplied Telegram API credentials.
//!
//! Tgb does not ship a registered Telegram app, so the user must
//! create one at <https://my.telegram.org> and paste the resulting
//! `api_id` / `api_hash` into the Settings page. The values are
//! persisted at `<data_root>/telegram/credentials.json`.
//!
//! The file is *not* a session — it does not contain login state or
//! tokens. It only holds the two strings the user pasted in. The
//! sandboxed-per-app data root is sufficient protection (Android
//! private storage; on desktop `~/tgb-player/`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::error::StorageError;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Credentials {
    pub api_id: i32,
    pub api_hash: String,
}

pub fn credentials_path(data_root: &Path) -> PathBuf {
    data_root.join("telegram").join("credentials.json")
}

pub async fn load(data_root: &Path) -> Result<Option<Credentials>, StorageError> {
    let path = credentials_path(data_root);
    match fs::read(&path).await {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub async fn save(data_root: &Path, creds: &Credentials) -> Result<(), StorageError> {
    let path = credentials_path(data_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(creds)?;
    fs::write(&path, bytes).await?;
    Ok(())
}

pub async fn clear(data_root: &Path) -> Result<(), StorageError> {
    let path = credentials_path(data_root);
    match fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn credentials_path_lives_under_telegram_dir() {
        let p = credentials_path(Path::new("/tmp/root"));
        assert_eq!(p, Path::new("/tmp/root/telegram/credentials.json"));
    }

    #[tokio::test]
    async fn load_returns_none_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let out = load(tmp.path()).await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let creds = Credentials {
            api_id: 12345,
            api_hash: "deadbeef".to_string(),
        };
        save(tmp.path(), &creds).await.unwrap();
        let loaded = load(tmp.path()).await.unwrap().expect("present");
        assert_eq!(loaded.api_id, 12345);
        assert_eq!(loaded.api_hash, "deadbeef");
    }

    #[tokio::test]
    async fn load_invalid_json_returns_error() {
        let tmp = TempDir::new().unwrap();
        let path = credentials_path(tmp.path());
        fs::create_dir_all(path.parent().unwrap()).await.unwrap();
        fs::write(&path, b"not-json").await.unwrap();
        let err = load(tmp.path()).await.unwrap_err();
        assert!(matches!(err, StorageError::Internal(_)));
    }

    #[tokio::test]
    async fn clear_removes_existing_and_swallows_missing() {
        let tmp = TempDir::new().unwrap();
        let creds = Credentials {
            api_id: 1,
            api_hash: "h".into(),
        };
        save(tmp.path(), &creds).await.unwrap();
        clear(tmp.path()).await.unwrap();
        assert!(load(tmp.path()).await.unwrap().is_none());
        // second clear is a no-op
        clear(tmp.path()).await.unwrap();
    }
}
