//! Signed-cookie bypass for the group-membership login gate.
//!
//! Once a signed-in account clears the [`crate::client::ConnectedClient`]
//! group-membership probe, `GET /api/telegram/status` mints a **signed,
//! 1-hour cookie** bound to that account's Telegram user id. While the
//! cookie is valid the status handler returns `authorized` **without**
//! re-running the (slow, network-bound) membership probe — see
//! [`crate::api::status`]. When the cookie expires the next routine status
//! poll re-probes once and re-issues a fresh cookie, transparently.
//!
//! The cookie is a bearer token of the form `"{user_id}.{exp}.{hmac_hex}"`
//! signed with an HMAC-SHA256 key that never leaves the server, so it can
//! be presented but not forged. The HMAC key is a random 32-byte secret
//! persisted (0600) at `<data_root>/telegram/access_cookie.key`; losing it
//! (or a backend restart that can't read it) just means existing cookies
//! stop verifying and the next poll re-probes + re-mints — no worse than a
//! cold start.

use std::io;
use std::path::{Path, PathBuf};

use axum::http::{header, HeaderMap};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Name of the bypass cookie set on the status response and read back on
/// subsequent requests.
pub const COOKIE_NAME: &str = "tgb_access";

/// Cookie / verdict-cache lifetime in seconds (one hour).
pub const TTL_SECS: i64 = 3600;

/// File under `<data_root>/telegram/` holding the random HMAC key.
const KEY_FILE: &str = "access_cookie.key";

/// HMAC-SHA256 signing key for the access-bypass cookie. 32 random bytes
/// generated once and persisted under the telegram data dir.
#[derive(Clone)]
pub struct AccessKey {
    bytes: [u8; 32],
}

impl AccessKey {
    /// Load the signing key from `<data_root>/telegram/access_cookie.key`,
    /// generating (and persisting, 0600) a fresh random key if the file is
    /// missing or unreadable.
    pub fn load_or_create(data_root: &Path) -> Self {
        let path = key_path(data_root);
        if let Some(bytes) = read_key(&path) {
            return Self { bytes };
        }
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        if let Err(e) = write_key(&path, &bytes) {
            // A non-persistable key still works for this process lifetime —
            // it just won't survive a restart. Warn and carry on.
            log::warn!(
                target: "tgb-telegram-storage",
                "could not persist access-cookie key at {}: {e}", path.display()
            );
        }
        Self { bytes }
    }

    /// Construct directly from raw bytes — test-only.
    #[cfg(test)]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    /// Mint a cookie token for `user_id` valid until `now_unix + TTL_SECS`.
    pub fn issue(&self, user_id: i64, now_unix: i64) -> String {
        let exp = now_unix + TTL_SECS;
        let payload = format!("{user_id}.{exp}");
        let mac = self.sign(payload.as_bytes());
        format!("{payload}.{}", hex_encode(&mac))
    }

    /// Verify a cookie token. Returns the bound `user_id` when the MAC
    /// checks out (constant-time) and the token has not yet expired.
    pub fn verify(&self, token: &str, now_unix: i64) -> Option<i64> {
        let mut parts = token.splitn(3, '.');
        let user_id_str = parts.next()?;
        let exp_str = parts.next()?;
        let mac_hex = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        let user_id: i64 = user_id_str.parse().ok()?;
        let exp: i64 = exp_str.parse().ok()?;
        if exp <= now_unix {
            return None;
        }
        let provided = hex_decode(mac_hex)?;
        let payload = format!("{user_id}.{exp}");
        let mut mac = HmacSha256::new_from_slice(&self.bytes).ok()?;
        mac.update(payload.as_bytes());
        // `verify_slice` is constant-time.
        mac.verify_slice(&provided).ok()?;
        Some(user_id)
    }

    fn sign(&self, msg: &[u8]) -> Vec<u8> {
        let mut mac =
            HmacSha256::new_from_slice(&self.bytes).expect("HMAC accepts any key length");
        mac.update(msg);
        mac.finalize().into_bytes().to_vec()
    }
}

/// Build the `Set-Cookie` header value for a freshly-minted `token`.
/// `HttpOnly` + `SameSite=Lax`; no `Secure` because the app is served over
/// loopback `http://`. `Max-Age` matches [`TTL_SECS`].
pub fn set_cookie_value(token: &str) -> String {
    format!("{COOKIE_NAME}={token}; Max-Age={TTL_SECS}; Path=/; HttpOnly; SameSite=Lax")
}

/// Pull the `tgb_access` cookie out of the request `Cookie` header(s).
pub fn parse_request_cookie(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(raw) = value.to_str() else { continue };
        for pair in raw.split(';') {
            let pair = pair.trim();
            if let Some(rest) = pair.strip_prefix(COOKIE_NAME) {
                if let Some(val) = rest.strip_prefix('=') {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn key_path(data_root: &Path) -> PathBuf {
    data_root.join("telegram").join(KEY_FILE)
}

/// Read a 32-byte key from disk, returning `None` if absent or the wrong
/// length (a truncated / corrupt file is treated as "regenerate").
fn read_key(path: &Path) -> Option<[u8; 32]> {
    let raw = std::fs::read(path).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&raw);
    Some(bytes)
}

/// Persist the key, creating the parent dir and tightening perms to 0600
/// on unix (the key is a credential; mirror the session-file convention).
fn write_key(path: &Path, bytes: &[u8; 32]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> AccessKey {
        AccessKey::from_bytes([7u8; 32])
    }

    #[test]
    fn issue_then_verify_round_trips() {
        let k = key();
        let now = 1_000_000;
        let token = k.issue(42, now);
        assert_eq!(k.verify(&token, now), Some(42));
        // Still valid just before expiry.
        assert_eq!(k.verify(&token, now + TTL_SECS - 1), Some(42));
    }

    #[test]
    fn expired_token_is_rejected() {
        let k = key();
        let now = 1_000_000;
        let token = k.issue(42, now);
        // exactly at exp and beyond → rejected.
        assert_eq!(k.verify(&token, now + TTL_SECS), None);
        assert_eq!(k.verify(&token, now + TTL_SECS + 10), None);
    }

    #[test]
    fn tampered_mac_is_rejected() {
        let k = key();
        let now = 1_000_000;
        let token = k.issue(42, now);
        // Flip the last hex nibble of the MAC.
        let mut chars: Vec<char> = token.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert_eq!(k.verify(&tampered, now), None);
    }

    #[test]
    fn wrong_user_id_in_payload_is_rejected() {
        let k = key();
        let now = 1_000_000;
        let token = k.issue(42, now);
        // Swap the user id but keep the original MAC → signature mismatch.
        let mac = token.rsplit('.').next().unwrap();
        let forged = format!("99.{}.{mac}", now + TTL_SECS);
        assert_eq!(k.verify(&forged, now), None);
    }

    #[test]
    fn different_key_does_not_verify() {
        let now = 1_000_000;
        let token = key().issue(42, now);
        let other = AccessKey::from_bytes([9u8; 32]);
        assert_eq!(other.verify(&token, now), None);
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        let k = key();
        let now = 1_000_000;
        assert_eq!(k.verify("", now), None);
        assert_eq!(k.verify("garbage", now), None);
        assert_eq!(k.verify("1.2", now), None);
        assert_eq!(k.verify("1.notanumber.abcd", now), None);
        assert_eq!(k.verify("1.2.zz", now), None); // non-hex MAC
        assert_eq!(k.verify("1.2.3.4", now), None); // too many segments
    }

    #[test]
    fn load_or_create_is_idempotent_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let k1 = AccessKey::load_or_create(tmp.path());
        let token = k1.issue(5, 1_000);
        // A second load reads the same persisted key, so old cookies verify.
        let k2 = AccessKey::load_or_create(tmp.path());
        assert_eq!(k2.verify(&token, 1_000), Some(5));

        let path = key_path(tmp.path());
        assert!(path.exists());
        let raw = std::fs::read(&path).unwrap();
        assert_eq!(raw.len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn parse_request_cookie_finds_value_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "foo=bar; tgb_access=tok123; baz=qux".parse().unwrap(),
        );
        assert_eq!(
            parse_request_cookie(&headers),
            Some("tok123".to_string())
        );

        let empty = HeaderMap::new();
        assert_eq!(parse_request_cookie(&empty), None);
    }

    #[test]
    fn set_cookie_value_has_expected_attributes() {
        let v = set_cookie_value("tok");
        assert!(v.starts_with("tgb_access=tok;"));
        assert!(v.contains("Max-Age=3600"));
        assert!(v.contains("HttpOnly"));
        assert!(v.contains("Path=/"));
        assert!(v.contains("SameSite=Lax"));
    }
}
