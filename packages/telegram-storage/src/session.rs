//! File-backed `grammers_session::Session` impl.
//!
//! Replaces `grammers_session::storages::SqliteSession` (which pulls in
//! `libsql` / `libsql-ffi` and bundles its own sqlite3 amalgamation).
//! Stacking that on top of sqlx's `libsqlite3-sys` (also bundled) emits
//! duplicate `sqlite3_*` symbols at link time. macOS's `ld64` silently
//! picks first-wins, but the Android NDK's `ld.lld` errors out, so the
//! `tgb-go-shell` Android build (`pnpm dev:go` / `pnpm build:go:android`)
//! fails to link. Persisting the MTProto session as JSON drops the libsql
//! dep entirely and leaves only one sqlite3 implementation in the binary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::future::BoxFuture;
use grammers_session::types::{
    ChannelState, DcOption, PeerId, PeerInfo, UpdateState, UpdatesState,
};
use grammers_session::{Session, SessionData};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct PersistedState {
    home_dc: i32,
    dc_options: Vec<DcOption>,
    peer_infos: Vec<PeerInfo>,
    updates_state: UpdatesState,
}

impl PersistedState {
    fn from_session_data(sd: &SessionData) -> Self {
        Self {
            home_dc: sd.home_dc,
            dc_options: sd.dc_options.values().cloned().collect(),
            peer_infos: sd.peer_infos.values().cloned().collect(),
            updates_state: sd.updates_state.clone(),
        }
    }

    fn into_session_data(self) -> SessionData {
        let mut dc_options: HashMap<i32, DcOption> = SessionData::default().dc_options;
        for dc in self.dc_options {
            dc_options.insert(dc.id, dc);
        }
        let mut peer_infos: HashMap<PeerId, PeerInfo> = HashMap::new();
        for info in self.peer_infos {
            peer_infos.insert(info.id(), info);
        }
        SessionData {
            home_dc: self.home_dc,
            dc_options,
            peer_infos,
            updates_state: self.updates_state,
        }
    }
}

pub struct FileSession {
    path: PathBuf,
    data: Mutex<SessionData>,
}

impl FileSession {
    pub async fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let data = match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() => {
                match serde_json::from_slice::<PersistedState>(&bytes) {
                    Ok(persisted) => persisted.into_session_data(),
                    Err(err) => {
                        log::warn!(
                            target: "tgb-telegram-storage",
                            "session file {} is unreadable ({}); starting fresh",
                            path.display(),
                            err
                        );
                        SessionData::default()
                    }
                }
            }
            _ => SessionData::default(),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    fn save_locked(&self, data: &SessionData) {
        let persisted = PersistedState::from_session_data(data);
        let bytes = match serde_json::to_vec(&persisted) {
            Ok(b) => b,
            Err(err) => {
                log::error!(target: "tgb-telegram-storage", "session serialize failed: {err}");
                return;
            }
        };
        let tmp = self.path.with_extension("json.tmp");
        if let Err(err) = std::fs::write(&tmp, &bytes) {
            log::error!(target: "tgb-telegram-storage", "session write {} failed: {err}", tmp.display());
            return;
        }
        if let Err(err) = std::fs::rename(&tmp, &self.path) {
            log::error!(target: "tgb-telegram-storage", "session rename to {} failed: {err}", self.path.display());
        }
    }
}

impl Session for FileSession {
    fn home_dc_id(&self) -> i32 {
        self.data.lock().unwrap().home_dc
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut data = self.data.lock().unwrap();
            data.home_dc = dc_id;
            self.save_locked(&data);
        })
    }

    fn dc_option(&self, dc_id: i32) -> Option<DcOption> {
        self.data.lock().unwrap().dc_options.get(&dc_id).cloned()
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, ()> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            let mut data = self.data.lock().unwrap();
            data.dc_options.insert(dc_option.id, dc_option);
            self.save_locked(&data);
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, Option<PeerInfo>> {
        Box::pin(async move { self.data.lock().unwrap().peer_infos.get(&peer).cloned() })
    }

    fn cache_peer(&self, peer: &PeerInfo) -> BoxFuture<'_, ()> {
        let peer = peer.clone();
        Box::pin(async move {
            let mut data = self.data.lock().unwrap();
            data.peer_infos.insert(peer.id(), peer);
            self.save_locked(&data);
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, UpdatesState> {
        Box::pin(async move { self.data.lock().unwrap().updates_state.clone() })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut data = self.data.lock().unwrap();
            match update {
                UpdateState::All(updates_state) => {
                    data.updates_state = updates_state;
                }
                UpdateState::Primary { pts, date, seq } => {
                    data.updates_state.pts = pts;
                    data.updates_state.date = date;
                    data.updates_state.seq = seq;
                }
                UpdateState::Secondary { qts } => {
                    data.updates_state.qts = qts;
                }
                UpdateState::Channel { id, pts } => {
                    data.updates_state.channels.retain(|c| c.id != id);
                    data.updates_state.channels.push(ChannelState { id, pts });
                }
            }
            self.save_locked(&data);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use grammers_session::types::DcOption;
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};
    use tempfile::TempDir;

    fn dc_option(id: i32) -> DcOption {
        DcOption {
            id,
            ipv4: SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443),
            ipv6: SocketAddrV6::new(Ipv6Addr::LOCALHOST, 443, 0, 0),
            auth_key: None,
        }
    }

    #[tokio::test]
    async fn open_missing_file_uses_session_default() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let session = FileSession::open(&path).await.unwrap();
        // SessionData::default sets DEFAULT_DC (currently 2).
        let default = SessionData::default();
        assert_eq!(session.home_dc_id(), default.home_dc);
    }

    #[tokio::test]
    async fn home_dc_set_and_get_persists_to_disk() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        {
            let s = FileSession::open(&path).await.unwrap();
            s.set_home_dc_id(4).await;
            assert_eq!(s.home_dc_id(), 4);
        }
        // Reopen — value should round-trip from disk.
        let s2 = FileSession::open(&path).await.unwrap();
        assert_eq!(s2.home_dc_id(), 4);
    }

    #[tokio::test]
    async fn dc_option_set_and_get() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        // High id outside the statically-known set should not exist yet.
        assert!(s.dc_option(99).is_none());
        let dc = dc_option(99);
        s.set_dc_option(&dc).await;
        assert!(s.dc_option(99).is_some());
    }

    #[tokio::test]
    async fn open_unreadable_file_falls_back_to_default() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        std::fs::write(&path, b"definitely-not-json").unwrap();
        let session = FileSession::open(&path).await.unwrap();
        let default = SessionData::default();
        assert_eq!(session.home_dc_id(), default.home_dc);
    }

    #[tokio::test]
    async fn updates_state_initially_default() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        let state = s.updates_state().await;
        // Default UpdatesState — primary pts/qts/date/seq all zero.
        assert_eq!(state.pts, 0);
        assert_eq!(state.qts, 0);
    }

    #[tokio::test]
    async fn set_update_state_primary_persists_pts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        s.set_update_state(UpdateState::Primary {
            pts: 100,
            date: 200,
            seq: 3,
        })
        .await;
        let state = s.updates_state().await;
        assert_eq!(state.pts, 100);
        assert_eq!(state.date, 200);
        assert_eq!(state.seq, 3);
    }

    #[tokio::test]
    async fn set_update_state_secondary_persists_qts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        s.set_update_state(UpdateState::Secondary { qts: 77 }).await;
        let state = s.updates_state().await;
        assert_eq!(state.qts, 77);
    }

    #[tokio::test]
    async fn set_update_state_channel_replaces_existing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        s.set_update_state(UpdateState::Channel { id: 1, pts: 5 })
            .await;
        s.set_update_state(UpdateState::Channel { id: 1, pts: 6 })
            .await;
        s.set_update_state(UpdateState::Channel { id: 2, pts: 7 })
            .await;
        let state = s.updates_state().await;
        assert_eq!(state.channels.len(), 2);
        let chan1 = state.channels.iter().find(|c| c.id == 1).unwrap();
        assert_eq!(chan1.pts, 6);
        let chan2 = state.channels.iter().find(|c| c.id == 2).unwrap();
        assert_eq!(chan2.pts, 7);
    }

    #[tokio::test]
    async fn set_update_state_all_replaces_state() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.json");
        let s = FileSession::open(&path).await.unwrap();
        s.set_update_state(UpdateState::Primary {
            pts: 5,
            date: 5,
            seq: 5,
        })
        .await;
        let mut new_state = UpdatesState::default();
        new_state.pts = 999;
        s.set_update_state(UpdateState::All(new_state)).await;
        let state = s.updates_state().await;
        assert_eq!(state.pts, 999);
    }
}
