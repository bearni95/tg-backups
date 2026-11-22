//! Minimal SQLite-pool newtype the crate threads through its handlers.
//!
//! In the upstream `tgb` monorepo this type lives in `tgb-app-core`
//! and is shared with several other backend crates. The port here keeps
//! `telegram-storage` self-contained — the only thing the crate ever
//! does with `Db` is hold it, clone it, and call `.pool()` against
//! `sqlx` queries, so the standalone copy carries only that surface.
//!
//! The host backend that embeds this crate is expected to open its own
//! `SqlitePool` (with whatever journal/synchronous/foreign-key options
//! it wants) and hand it in via [`TelegramConfig`].

use sqlx::SqlitePool;

/// Cloned-cheaply handle to a SQLite database.
#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[tokio::test]
    async fn new_wraps_pool_and_clone_shares_handle() {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let db = Db::new(pool);
        let db2 = db.clone();
        assert!(db.pool().acquire().await.is_ok());
        assert!(db2.pool().acquire().await.is_ok());
    }
}
