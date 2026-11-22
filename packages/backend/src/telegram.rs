//! Wires the standalone `tgb-telegram-storage` crate into the backend.
//!
//! Opens (and migrates) a dedicated SQLite database under
//! `<data_root>/telegram/index.sqlite`, boots a
//! [`tgb_telegram_storage::TelegramStorage`] against it, and returns
//! the crate's Axum router so `serve()` can nest it at `/api/telegram`.
//!
//! Storage goes to the one shared group named by
//! `TGB_TELEGRAM_ACCESS_GROUP` (read inside the storage crate); there is
//! no per-user fallback. See
//! `tgb_telegram_storage::client::ConnectedClient::target_peer`.

use std::path::Path;

use anyhow::Context;
use axum::Router;
use tgb_telegram_storage::{Db, TelegramConfig, TelegramStorage};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

pub struct TelegramBackend {
    pub router: Router,
    pub storage: TelegramStorage,
}

pub async fn setup(data_root: &Path) -> anyhow::Result<TelegramBackend> {
    let telegram_root = data_root.join("telegram");
    std::fs::create_dir_all(&telegram_root)
        .with_context(|| format!("create {}", telegram_root.display()))?;

    let db_path = telegram_root.join("index.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .with_context(|| format!("open sqlite at {}", db_path.display()))?;
    let db = Db::new(pool);

    let storage = TelegramStorage::init(TelegramConfig {
        data_root: data_root.to_path_buf(),
        db,
        event_sink: None,
    })
    .await
    .context("init TelegramStorage")?;

    tracing::info!(
        "telegram storage initialised (index at {})",
        db_path.display()
    );

    let router = tgb_telegram_storage::router(storage.clone());
    Ok(TelegramBackend { router, storage })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::Once;

    static INIT: Once = Once::new();
    fn ensure_tracing() {
        INIT.call_once(|| {
            tracing_subscriber::fmt()
                .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
                .try_init()
                .ok();
        });
    }

    /// Capture and restore the TELEGRAM env vars so the
    /// no-credentials boot path is taken regardless of the host env.
    struct EnvGuard {
        keys: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn capture(keys: &[&'static str]) -> Self {
            let snap = keys.iter().map(|k| (*k, std::env::var(*k).ok())).collect();
            for k in keys {
                std::env::remove_var(k);
            }
            Self { keys: snap }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.keys {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn setup_boots_without_credentials() {
        ensure_tracing();
        let _g = EnvGuard::capture(&["TELEGRAM_API_ID", "TELEGRAM_API_HASH"]);
        let tmp = tempfile::tempdir().unwrap();
        let backend = setup(tmp.path()).await.expect("setup ok");
        // Sanity: the index DB file and dir exist.
        assert!(tmp.path().join("telegram").is_dir());
        assert!(tmp.path().join("telegram").join("index.sqlite").exists());
        // Storage handle is usable.
        let _ = backend.storage.list().await;
    }

    #[tokio::test]
    #[serial]
    async fn env_guard_restores_previous_value() {
        // Set a value, then capture+drop the guard — Drop's
        // `Some(v) => set_var` arm runs to restore it.
        std::env::set_var("TGB_TEST_ENV_GUARD", "before");
        {
            let _g = EnvGuard::capture(&["TGB_TEST_ENV_GUARD"]);
            // While the guard is alive the var was removed.
            assert!(std::env::var("TGB_TEST_ENV_GUARD").is_err());
        }
        // After drop, the previous value should be restored.
        assert_eq!(std::env::var("TGB_TEST_ENV_GUARD").unwrap(), "before");
        std::env::remove_var("TGB_TEST_ENV_GUARD");
    }
}
