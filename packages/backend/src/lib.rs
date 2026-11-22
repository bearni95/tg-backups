//! Local backend for tg-backups.
//!
//! - `/api/health` → liveness
//! - `/api/telegram` → `tgb-telegram-storage` (MTProto file storage)
//! - everything else → the built SPA in `dist/`
//!
//! Runtime data lives under `$TGB_DATA_DIR` (default `<home>/tg-backups/`).

use std::net::Ipv4Addr;

use anyhow::Context;
use axum::{middleware, Router};
use tower_http::services::{ServeDir, ServeFile};

pub mod data_dir;
pub mod health;
mod local_only;
pub mod telegram;

const DEFAULT_PORT: u16 = 9811;

pub async fn serve() -> anyhow::Result<()> {
    // Before anything reads the environment: the storage crate takes its
    // credentials and group from env vars.
    let dotenv_result = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init()
        .ok();
    if let Err(e) = &dotenv_result {
        if !e.not_found() {
            tracing::warn!("failed to load .env: {e}");
        }
    }

    let data_root = data_dir::resolve();
    tracing::info!("data root: {}", data_root.display());
    let telegram = telegram::setup(&data_root).await?;

    let port = match std::env::var("TGB_PORT") {
        Ok(value) if !value.is_empty() => value.parse().context("TGB_PORT is not a port")?,
        _ => DEFAULT_PORT,
    };
    let app = app(telegram.router);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    tracing::info!("listening on http://localhost:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn app(telegram: Router) -> Router {
    // No CORS and no compression: the SPA is same-origin, and zips don't
    // compress, while compression would drop the `Content-Length` that lets
    // a browser detect a truncated restore.
    Router::new()
        .nest("/api/health", health::router())
        .nest("/api/telegram", telegram)
        .fallback_service(ServeDir::new("dist").fallback(ServeFile::new("dist/index.html")))
        .layer(middleware::from_fn(local_only::guard))
}
