use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // Bake build-time Telegram credentials into a generated source file so
    // the values end up as plain string literals in the binary. Mirrors the
    // pattern `packages/backend/build.rs` uses for `TMDB_API_KEY`: a
    // generated file in `OUT_DIR` (rather than `option_env!`) survives
    // cargo's incremental-build cache better when CI restores an older
    // `.fingerprint/` directory.
    //
    // The runtime fallback chain stays unchanged: on-disk
    // `<data_root>/telegram/credentials.json` wins, then runtime env vars
    // (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`), and finally these embedded
    // constants — so a packaged Android APK ships with sensible defaults
    // while desktop dev with a `.env` and ad-hoc UI overrides keep working.
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR not set"));
    let embedded = out_dir.join("embedded_keys.rs");
    let api_id = env::var("TELEGRAM_API_ID").unwrap_or_default();
    let api_hash = env::var("TELEGRAM_API_HASH").unwrap_or_default();
    let generated = format!(
        "pub const TELEGRAM_API_ID: &str = {api_id:?};\npub const TELEGRAM_API_HASH: &str = {api_hash:?};\n"
    );
    fs::write(&embedded, generated).expect("failed to write embedded_keys.rs");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TELEGRAM_API_ID");
    println!("cargo:rerun-if-env-changed=TELEGRAM_API_HASH");
}
