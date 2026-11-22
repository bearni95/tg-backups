//! Stream a stored file back to the caller.
//!
//! Two flavours:
//! - [`download`] streams the entire file from byte 0.
//! - [`download_range`] streams a `[start, end]` byte range (inclusive).
//!
//! Both return a tokio receiver of `Vec<u8>` chunks the route handler
//! wraps into an Axum body. Safari iOS requires `Accept-Ranges: bytes`
//! + working byte-range responses for HTML5 audio/video — without it
//! the player buffers forever after its initial probe. The route
//! handler in `api.rs` parses the request's `Range` header and picks
//! the right flavour.
//!
//! ## Multipart files
//!
//! A logical file may live across multiple Telegram messages (see
//! [`crate::upload`] — files >1 GiB get split into ≤1 GiB chunks). The
//! download path reads the `tg_file_part` rows ordered by `ord`,
//! batches their messages in a single `get_messages_by_id` round-trip,
//! and then iterates them sequentially within the requested byte
//! range. Single-part files (the common case) go through the same code
//! path with `parts.len() == 1`, so there's no separate legacy branch.

use grammers_client::Client;
use tokio::sync::mpsc;

use crate::client::ConnectedClient;
use crate::db::{self as index_db, FilePart, FileRow};
use crate::error::StorageError;
use crate::pool::Db;

/// MTProto upload.GetFile chunk-size bounds (mirrored from
/// grammers-client's private `files` module). The TL request requires
/// `offset` to be a multiple of `MIN_CHUNK_SIZE`, and `limit` to be a
/// multiple of `MIN_CHUNK_SIZE` in `[MIN_CHUNK_SIZE, MAX_CHUNK_SIZE]`.
const MAX_CHUNK_SIZE: u64 = 512 * 1024;

pub struct DownloadStream {
    pub rx: mpsc::Receiver<Result<Vec<u8>, StorageError>>,
}

/// Stream the full file from byte 0. Thin wrapper over
/// [`download_range`].
pub async fn download(
    connected: &ConnectedClient,
    db: &Db,
    row: &FileRow,
) -> Result<DownloadStream, StorageError> {
    let total = row.size_bytes.max(0) as u64;
    let end = total.saturating_sub(1);
    download_range(connected, db, row, 0, end).await
}

/// Stream the inclusive byte range `[start, end]` from the stored
/// file. The MTProto download iterator runs in a spawned task so the
/// receiver can pump while the handler is still inside its `.await`.
///
/// Empty ranges (`start > end`, or `total == 0`) succeed with an empty
/// stream — callers handle the headers (Content-Length 0, etc.). Out-
/// of-bounds requests should be rejected by the caller before reaching
/// this function; the validation here is the last line of defence.
pub async fn download_range(
    connected: &ConnectedClient,
    db: &Db,
    row: &FileRow,
    start: u64,
    end: u64,
) -> Result<DownloadStream, StorageError> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, StorageError>>(8);
    let length = end.saturating_sub(start).saturating_add(1);
    if start > end || length == 0 {
        drop(tx);
        return Ok(DownloadStream { rx });
    }

    let target = connected.target_peer().await?;
    let parts = index_db::list_parts(db, &row.id).await?;
    let parts = if parts.is_empty() {
        // No backfilled part rows yet (shouldn't happen post-`migrate`,
        // but stay defensive — synthesise a single part from the head
        // row so a malformed DB doesn't 404 silently).
        vec![FilePart {
            tg_file_id: row.id.clone(),
            ord: 0,
            tg_message_id: row.tg_message_id,
            size_bytes: row.size_bytes,
            checksum_sha256: None,
        }]
    } else {
        parts
    };

    // grammers-client filters `get_messages_by_id`'s response with
    // `m.peer_id() == peer.id`. `InputPeerSelf` produces a sentinel
    // `SELF_USER_ID` that never matches the real user id stamped on an
    // incoming Saved-Messages message, so the call silently returns
    // `[None]` for every existing message. The per-app named-chat path
    // has the same hazard (sentinel != real channel id), so we always
    // use the resolved peer ref (real id + access hash). Cached on
    // ConnectedClient so dialog walk / get_me happens at most once.
    let msg_ids: Vec<i32> = parts.iter().map(|p| p.tg_message_id as i32).collect();
    let msgs = connected
        .client
        .get_messages_by_id(target, &msg_ids)
        .await?;

    // Match messages back to parts by id. `get_messages_by_id` returns a
    // `Vec<Option<Message>>` in the same order as the input ids, with
    // `None` for any deleted / unreachable message; we propagate `None`
    // as `NotFound` to mirror the single-part error contract.
    let mut part_media: Vec<(u64, grammers_client::media::Media)> = Vec::with_capacity(parts.len());
    for (part, msg) in parts.iter().zip(msgs.into_iter()) {
        let msg = msg.ok_or(StorageError::NotFound)?;
        let media = msg
            .media()
            .ok_or_else(|| StorageError::Internal("stored message has no media payload".into()))?;
        part_media.push((part.size_bytes.max(0) as u64, media));
    }

    let client = connected.client.clone();
    tokio::spawn(async move {
        if let Err(e) = stream_parts(client, part_media, start, length, tx.clone()).await {
            let _ = tx.send(Err(e)).await;
        }
    });

    Ok(DownloadStream { rx })
}

/// Walk every part whose byte range overlaps `[start, start + length)`
/// and forward the matching slice through `tx`. Parts that lie entirely
/// before `start` are skipped without touching MTProto; parts that lie
/// entirely past the requested range short-circuit the loop.
async fn stream_parts(
    client: Client,
    parts: Vec<(u64, grammers_client::media::Media)>,
    start: u64,
    length: u64,
    tx: mpsc::Sender<Result<Vec<u8>, StorageError>>,
) -> Result<(), StorageError> {
    let mut part_offset: u64 = 0;
    let mut bytes_remaining = length;
    for (part_size, media) in parts {
        if bytes_remaining == 0 {
            break;
        }
        let part_end = part_offset.saturating_add(part_size);
        if start >= part_end {
            // Requested range starts past this whole part; skip.
            part_offset = part_end;
            continue;
        }
        let local_start = start.saturating_sub(part_offset);
        let local_take = part_size.saturating_sub(local_start).min(bytes_remaining);
        if local_take == 0 {
            part_offset = part_end;
            continue;
        }

        // Align `local_start` down to MAX_CHUNK_SIZE so the MTProto
        // GetFile RPC's `offset` lands on a permitted multiple. We pull
        // from `aligned_start` and drop the prefix bytes out of the
        // first chunk. Worst-case waste: 512 KiB - 1 bytes per Range
        // request, far cheaper than 4 KiB chunks at the per-RPC level.
        let aligned_start = local_start - (local_start % MAX_CHUNK_SIZE);
        let skip_count: i32 = (aligned_start / MAX_CHUNK_SIZE)
            .try_into()
            .unwrap_or(i32::MAX);
        let mut bytes_to_drop = local_start - aligned_start;
        let mut local_remaining = local_take;

        let mut iter = client.iter_download(&media);
        if skip_count > 0 {
            iter = iter.skip_chunks(skip_count);
        }
        loop {
            if local_remaining == 0 {
                break;
            }
            match iter.next().await {
                Ok(Some(mut chunk)) => {
                    if bytes_to_drop > 0 {
                        let drop_n = (bytes_to_drop as usize).min(chunk.len());
                        chunk.drain(..drop_n);
                        bytes_to_drop -= drop_n as u64;
                    }
                    if chunk.is_empty() {
                        continue;
                    }
                    let take_n = (local_remaining as usize).min(chunk.len());
                    if take_n < chunk.len() {
                        chunk.truncate(take_n);
                    }
                    if !chunk.is_empty() && tx.send(Ok(chunk)).await.is_err() {
                        // Receiver dropped (client disconnected). Stop
                        // wasting bandwidth on a stream nobody's reading.
                        return Ok(());
                    }
                    local_remaining -= take_n as u64;
                    bytes_remaining -= take_n as u64;
                }
                Ok(None) => break,
                Err(e) => return Err(e.into()),
            }
        }

        part_offset = part_end;
    }
    Ok(())
}

/// Wipe every message from the destination chat and clear the local
/// `tg_files` / `tg_file_part` index in one shot. Walks the chat
/// history via `iter_messages`, collects every message id, then issues
/// `delete_messages` calls in batches of 100 (the Telegram per-call
/// cap for both `messages.deleteMessages` and `channels.deleteMessages`).
/// Per-batch failures are logged and the loop continues so a single
/// bad id (service message, already-deleted, …) doesn't strand the
/// rest. The index `clear_all` runs after the chat sweep so a partial
/// network failure during the message drop doesn't desync the WebUI
/// from what's still up on Telegram.
pub async fn delete_all(connected: &ConnectedClient, db: &Db) -> Result<usize, StorageError> {
    let target = connected.target_peer().await?;
    let mut all_ids: Vec<i32> = Vec::new();
    let mut iter = connected.client.iter_messages(target);
    while let Some(msg) = iter.next().await? {
        all_ids.push(msg.id());
    }
    let total = all_ids.len();
    for chunk in all_ids.chunks(100) {
        if let Err(e) = connected.client.delete_messages(target, chunk).await {
            log::warn!(
                target: "tgb-telegram-storage",
                "delete_messages batch of {} failed (continuing): {e}",
                chunk.len(),
            );
        }
    }
    crate::db::clear_all(db).await?;
    Ok(total)
}

/// Drop a set of raw message ids from the destination chat, in batches
/// of 100 (the Telegram per-call cap). Touches **only** the chat — no
/// `tg_files` index rows are consulted or removed — so it's the tool
/// for deleting the plain-text / document reply messages the acquisition
/// stack threads (`*-metadata` messages) that never land in the file
/// index. Per-batch failures are logged and the loop continues so one
/// already-deleted / unreachable id doesn't strand the rest. An empty
/// id list is a no-op. Best-effort: returns `Ok(())` even when Telegram
/// rejects a batch (a nuke should not fail because a message was already
/// gone).
pub async fn delete_message_ids(
    connected: &ConnectedClient,
    ids: &[i64],
) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let target = connected.target_peer().await?;
    let msg_ids: Vec<i32> = ids.iter().map(|&id| id as i32).collect();
    for chunk in msg_ids.chunks(100) {
        if let Err(e) = connected.client.delete_messages(target, chunk).await {
            log::warn!(
                target: "tgb-telegram-storage",
                "delete_messages batch of {} failed (continuing): {e}",
                chunk.len(),
            );
        }
    }
    Ok(())
}

/// Delete a file: drop every part message in the per-app storage chat,
/// then drop the index row. If a message id is gone (already deleted,
/// etc.) we log and continue — the index row still goes away so the UI
/// doesn't get stuck on a phantom entry. The FK cascade drops every
/// `tg_file_part` row alongside the `tg_files` head.
pub async fn delete(
    connected: &ConnectedClient,
    db: &Db,
    row: &FileRow,
) -> Result<(), StorageError> {
    let target = connected.target_peer().await?;
    let parts = index_db::list_parts(db, &row.id).await?;
    let mut msg_ids: Vec<i32> = parts.iter().map(|p| p.tg_message_id as i32).collect();
    if msg_ids.is_empty() {
        // Defensive: legacy row with no part backfill. Use the head
        // row's message id instead so the chat-side cleanup still runs.
        msg_ids.push(row.tg_message_id as i32);
    }
    if let Err(e) = connected.client.delete_messages(target, &msg_ids).await {
        log::warn!(
            target: "tgb-telegram-storage",
            "delete_messages({msg_ids:?}) failed, dropping index row anyway: {e}",
        );
    }
    crate::db::delete(db, &row.id).await?;
    Ok(())
}
