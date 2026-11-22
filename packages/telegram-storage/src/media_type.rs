//! Upload allowlist.
//!
//! The tgb group is a backing store for backups, so zip files are the only
//! thing accepted. Every upload entry point routes through [`is_allowed`], as
//! does the chat reconcile for documents that carry no tgb marker.

/// What browsers and `mime_guess` report for a zip, plus the generic types
/// they fall back to.
const ZIP_MIME_TYPES: &[&str] = &[
    "application/zip",
    "application/x-zip",
    "application/x-zip-compressed",
    "application/x-compressed",
    "multipart/x-zip",
    "application/octet-stream",
    "",
];

/// Whether `(name, mime_type)` is a zip. The `.zip` extension is required so
/// a restored file always opens as an archive. Case-insensitive.
pub fn is_allowed(name: &str, mime_type: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && ext.eq_ignore_ascii_case("zip")
        && ZIP_MIME_TYPES.contains(&mime_type.trim().to_ascii_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_zip_mime_variants() {
        for mime in ZIP_MIME_TYPES {
            assert!(is_allowed("backup.zip", mime), "{mime}");
        }
        assert!(is_allowed("Photos.2026.ZIP", "APPLICATION/ZIP"));
    }

    #[test]
    fn rejects_everything_else() {
        assert!(!is_allowed("clip.mp4", "video/mp4"));
        assert!(!is_allowed("backup.tar.gz", "application/gzip"));
        assert!(!is_allowed("backup.zip.part1of3", "application/octet-stream"));
        assert!(!is_allowed("backup", "application/zip"));
        assert!(!is_allowed(".zip", "application/zip"));
        assert!(!is_allowed("fake.zip", "text/html"));
    }
}
