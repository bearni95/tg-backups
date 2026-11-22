//! Media-type allowlist for uploads.
//!
//! The Telegram chat is a backing store for *playable* media — video and
//! audio. Earlier flows let multi-file torrents fan out into one upload
//! per regular file, which dumped subtitle `.srt`s, cover-art `.jpg`s,
//! `.nfo` text, and other torrent-bundled noise into the chat. This
//! module is the single source of truth for what the upload paths
//! accept: video/* and audio/* MIME types, plus a small extension
//! fallback for the cases where `mime_guess` returns
//! `application/octet-stream`.
//!
//! Every upload entry point routes through [`is_allowed`] so the gate
//! is consistent across the HTTP multipart handler, the
//! upload-from-path handler, the background upload spawn, and the
//! direct `upload_stream` / `upload_local_file` Rust callers.

/// Audio extensions accepted even when MIME detection bails out to
/// `application/octet-stream`. Telegram itself doesn't care about the
/// extension — this is purely to keep the allowlist consistent when the
/// caller hands us a generic MIME.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "wma", "alac", "ape", "aiff", "aif",
];

/// Video extensions accepted even when MIME detection bails out. Mirrors
/// `packages/pipeline/src/format.rs::KNOWN_CONTAINERS` so the formats
/// the search/select step recognises are exactly the formats the upload
/// step accepts.
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "ogv", "ts", "mpg", "mpeg", "3gp",
];

/// Subtitle extensions accepted so the acquisition stack can keep a shared
/// WebVTT subtitle per (media, language) on Telegram, deduped by a
/// deterministic name. Deliberately **only `.vtt`** (the format the
/// subtitle path always converts to before upload) — the torrent-bundled
/// `.srt` noise this allowlist was written to keep out of the chat is still
/// rejected.
const SUBTITLE_EXTENSIONS: &[&str] = &["vtt"];

/// Whether `(name, mime_type)` represents a video or audio file. Used
/// by the upload path to reject text, images, archives, and other
/// torrent-bundled noise (.srt, .nfo, cover.jpg, …) that would
/// otherwise land in the per-app Telegram chat.
///
/// Decision order:
/// 1. If `mime_type` starts with `video/` or `audio/`, accept.
/// 2. If `mime_type` is `application/json`, accept — used by the
///    pipeline runner to ship a metadata sidecar alongside each media
///    upload so the catalog can show the addon's response next to the
///    playable file.
/// 3. If `mime_type` is `text/vtt`, accept — used by the acquisition
///    stack to keep a shared WebVTT subtitle per (media, language) on
///    Telegram, deduped by a deterministic name.
/// 4. Otherwise, fall back to the file extension allowlist
///    ([`VIDEO_EXTENSIONS`] / [`AUDIO_EXTENSIONS`] / [`SUBTITLE_EXTENSIONS`],
///    plus `.json`). This
///    covers cases where the caller passed `application/octet-stream`
///    because `mime_guess` didn't recognise the extension or the caller
///    didn't bother to populate it.
///
/// All comparisons are case-insensitive.
pub fn is_allowed(name: &str, mime_type: &str) -> bool {
    let m = mime_type.trim().to_ascii_lowercase();
    if m.starts_with("video/") || m.starts_with("audio/") {
        return true;
    }
    if m == "application/json" {
        return true;
    }
    // WebVTT subtitles: the acquisition stack stores one shared `.vtt` per
    // (media, language) on Telegram so a subtitle fetched on one device is
    // reusable on another without re-querying the subtitle addon.
    if m == "text/vtt" {
        return true;
    }
    matches_extension(name)
}

fn matches_extension(name: &str) -> bool {
    let Some(ext) = name.rsplit('.').next() else {
        return false;
    };
    // `rsplit` returns the whole string when there's no `.` — guard
    // against that so a bare `"README"` doesn't get treated as a
    // `"readme"` extension.
    if ext == name {
        return false;
    }
    let lower = ext.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    VIDEO_EXTENSIONS.contains(&lower.as_str())
        || AUDIO_EXTENSIONS.contains(&lower.as_str())
        || SUBTITLE_EXTENSIONS.contains(&lower.as_str())
        || lower == "json"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_video_mime() {
        assert!(is_allowed("clip.mp4", "video/mp4"));
        assert!(is_allowed("foo.bin", "VIDEO/x-matroska"));
    }

    #[test]
    fn accepts_audio_mime() {
        assert!(is_allowed("track.mp3", "audio/mpeg"));
        assert!(is_allowed("track.flac", "AUDIO/flac"));
    }

    #[test]
    fn rejects_image_mime() {
        assert!(!is_allowed("cover.jpg", "image/jpeg"));
        assert!(!is_allowed("poster.png", "image/png"));
    }

    #[test]
    fn rejects_text_mime() {
        assert!(!is_allowed("subs.srt", "text/plain"));
        assert!(!is_allowed("info.nfo", "text/plain"));
        assert!(!is_allowed("readme.txt", "text/plain"));
    }

    #[test]
    fn falls_back_to_video_extension_when_mime_is_generic() {
        assert!(is_allowed("Movie.2024.mkv", "application/octet-stream"));
        assert!(is_allowed("clip.WEBM", "application/octet-stream"));
    }

    #[test]
    fn falls_back_to_audio_extension_when_mime_is_generic() {
        assert!(is_allowed("song.flac", "application/octet-stream"));
        assert!(is_allowed("podcast.M4A", "application/octet-stream"));
    }

    #[test]
    fn rejects_unknown_extension_with_generic_mime() {
        assert!(!is_allowed("subs.srt", "application/octet-stream"));
        assert!(!is_allowed("cover.jpg", "application/octet-stream"));
        assert!(!is_allowed("README", "application/octet-stream"));
        assert!(!is_allowed("noext", "application/octet-stream"));
    }

    #[test]
    fn accepts_webvtt_subtitle() {
        // The acquisition stack stores one shared `.vtt` per (media,
        // language) on Telegram, so a subtitle fetched on one device is
        // reusable on another.
        assert!(is_allowed("sub__603__s00e00__en.vtt", "text/vtt"));
        assert!(is_allowed("sub__603__s01e02__es.vtt", "application/octet-stream"));
        assert!(is_allowed("caption.VTT", "text/vtt"));
    }

    #[test]
    fn still_rejects_srt_subtitle_noise() {
        // Only `.vtt` is allowed; torrent-bundled `.srt` stays rejected.
        assert!(!is_allowed("subs.srt", "text/plain"));
        assert!(!is_allowed("subs.srt", "application/octet-stream"));
        assert!(!is_allowed("subs.srt", "application/x-subrip"));
    }

    #[test]
    fn accepts_json_metadata_sidecar() {
        // Pipeline step 7 ships a metadata.json next to each media
        // upload so the catalog can pair the addon response with the
        // playable file. Accept the JSON mime and the bare extension.
        assert!(is_allowed("pl-123.metadata.json", "application/json"));
        assert!(is_allowed(
            "movie - metadata.json",
            "application/octet-stream"
        ));
        assert!(is_allowed("clip.JSON", "application/json"));
    }
}
