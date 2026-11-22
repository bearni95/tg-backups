//! Resolves the root directory for runtime-generated state owned by the
//! backend.
//!
//! Everything the running app writes to disk — the Telegram session, the index and
//! staged uploads — must live
//! under a single root so a user can wipe their state with a single
//! `rm -rf`. The convention is `<home>/tg-backups/`, overridable with the
//! `TGB_DATA_DIR` env var (handy for tests + sandboxed environments
//! where `dirs::home_dir()` returns something useless).

use std::path::PathBuf;

const ENV_VAR: &str = "TGB_DATA_DIR";
const SUBDIR: &str = "tg-backups";

/// Best-effort resolution. Falls back to the current working directory's
/// `tg-backups/` subdir if the home dir can't be determined — that's never
/// expected in production, but keeps `serve()` infallible on weird hosts
/// (containers, CI runners without `$HOME`).
pub fn resolve() -> PathBuf {
    resolve_with(
        std::env::var(ENV_VAR).ok().as_deref(),
        dirs::home_dir().as_deref(),
    )
}

fn resolve_with(env_value: Option<&str>, home: Option<&std::path::Path>) -> PathBuf {
    if let Some(p) = env_value {
        let path = PathBuf::from(p);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    if let Some(home) = home {
        return home.join(SUBDIR);
    }
    PathBuf::from(SUBDIR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn env_var_overrides_default() {
        std::env::set_var(ENV_VAR, "/tmp/my-tgb-data");
        let resolved = resolve();
        assert_eq!(resolved, PathBuf::from("/tmp/my-tgb-data"));
        std::env::remove_var(ENV_VAR);
    }

    #[test]
    #[serial]
    fn empty_env_falls_through_to_home() {
        std::env::set_var(ENV_VAR, "");
        let resolved = resolve();
        std::env::remove_var(ENV_VAR);

        // Should fall through to home_dir().join("tg-backups") OR ./tgb when no home.
        let expected = dirs::home_dir()
            .map(|h| h.join(SUBDIR))
            .unwrap_or_else(|| PathBuf::from(SUBDIR));
        assert_eq!(resolved, expected);
    }

    #[test]
    #[serial]
    fn no_env_falls_through_to_home() {
        std::env::remove_var(ENV_VAR);
        let resolved = resolve();
        let expected = dirs::home_dir()
            .map(|h| h.join(SUBDIR))
            .unwrap_or_else(|| PathBuf::from(SUBDIR));
        assert_eq!(resolved, expected);
    }

    #[test]
    #[serial]
    fn fallback_to_cwd_when_no_home() {
        // resolve_with(None, None) covers the final fallback branch
        // without having to mock `dirs::home_dir()`.
        let p = resolve_with(None, None);
        assert_eq!(p, PathBuf::from(SUBDIR));
    }

    #[test]
    fn helper_env_overrides_even_when_home_is_some() {
        let p = resolve_with(
            Some("/custom/path"),
            Some(std::path::Path::new("/home/dummy")),
        );
        assert_eq!(p, PathBuf::from("/custom/path"));
    }

    #[test]
    fn helper_empty_env_uses_home() {
        let p = resolve_with(Some(""), Some(std::path::Path::new("/home/dummy")));
        assert_eq!(p, PathBuf::from("/home/dummy/tg-backups"));
    }
}
