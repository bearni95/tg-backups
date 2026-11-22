//! Content identity for backups.
//!
//! The chunk engine treats `(name, size)` as one logical file, both when it
//! resumes an upload and when it rebuilds the index from the chat. Backups
//! break that assumption: `db.zip` is uploaded again and again with different
//! bytes and sometimes the same size, which would make a new backup "resume"
//! into the old one, or make two versions rebuild as one.
//!
//! So the name stored on Telegram carries a fingerprint of the content
//! (`db.tgb-<12 hex>.zip`), leaving the engine and its marker format untouched.
//! The API always shows and restores the original name.

use std::io::SeekFrom;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};

use crate::error::StorageError;
use crate::upload::UploadAbortControl;

const TAG: &str = ".tgb-";
const FINGERPRINT_LEN: usize = 12;
const READ_BUFFER_BYTES: usize = 1024 * 1024;

/// SHA-256 of the next `size` bytes. Leaves the cursor where it found it.
pub(crate) async fn content_sha256<S>(
    source: &mut S,
    size: u64,
    abort: Option<&Arc<UploadAbortControl>>,
) -> Result<String, StorageError>
where
    S: AsyncRead + AsyncSeek + Unpin,
{
    let start = source.stream_position().await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; READ_BUFFER_BYTES];
    let mut reader = (&mut *source).take(size);
    loop {
        if abort.is_some_and(|a| a.is_aborted()) {
            return Err(StorageError::UploadAborted);
        }
        let read = reader.read(&mut buf).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    source.seek(SeekFrom::Start(start)).await?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// `db.zip` + digest → `db.tgb-<fingerprint>.zip`.
pub(crate) fn stored_name(name: &str, sha256_hex: &str) -> String {
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "zip"));
    format!("{stem}{TAG}{}.{ext}", &sha256_hex[..FINGERPRINT_LEN])
}

/// Inverse of [`stored_name`]. Names without a fingerprint pass through.
pub(crate) fn original_name(stored: &str) -> String {
    stored
        .rsplit_once('.')
        .and_then(|(head, ext)| {
            let (stem, fingerprint) = head.rsplit_once(TAG)?;
            (fingerprint.len() == FINGERPRINT_LEN
                && fingerprint.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| format!("{stem}.{ext}"))
        })
        .unwrap_or_else(|| stored.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn same_name_and_size_with_different_content_gets_a_different_identity() {
        let a = content_sha256(&mut Cursor::new(b"monday".to_vec()), 6, None)
            .await
            .unwrap();
        let b = content_sha256(&mut Cursor::new(b"friday".to_vec()), 6, None)
            .await
            .unwrap();
        assert_ne!(stored_name("db.zip", &a), stored_name("db.zip", &b));
    }

    #[tokio::test]
    async fn hashing_spans_buffers_and_restores_the_cursor() {
        let bytes = vec![7u8; READ_BUFFER_BYTES * 2 + 3];
        let mut source = Cursor::new(bytes.clone());
        let hash = content_sha256(&mut source, bytes.len() as u64, None)
            .await
            .unwrap();
        assert_eq!(hash, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(source.position(), 0);
    }

    #[tokio::test]
    async fn hashing_can_be_cancelled() {
        let abort = Arc::new(UploadAbortControl::new());
        abort.abort();
        let err = content_sha256(&mut Cursor::new(vec![0u8; 8]), 8, Some(&abort))
            .await
            .unwrap_err();
        assert!(matches!(err, StorageError::UploadAborted));
    }

    #[test]
    fn original_name_roundtrips() {
        let hash = "0123456789abcdef";
        for name in ["db.zip", "my.photos.2026.ZIP", "còpia de seguretat.zip", "x.tgb-y.zip"] {
            assert_eq!(original_name(&stored_name(name, hash)), name);
        }
        assert_eq!(original_name("plain.zip"), "plain.zip");
        assert_eq!(original_name("x.tgb-nothex.zip"), "x.tgb-nothex.zip");
    }
}
