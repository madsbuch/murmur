//! Durable, local-first notes. The UI never owns the authoritative document.
pub(crate) use crate::files::MissingFile;
use crate::files::{self, FileRecord};
pub use crate::files::{FileContent, SharedFile, MAX_FILE_BYTES};
pub use crate::incoming::PendingShare;
use crate::incoming::{self, QueuedShare};
use crate::invitations;
use crate::storage::{DraftClear, Store, StoredBlob, StoredDraft, StoredNetwork, StoredState};
use crate::tags::{self, TagKind};
use automerge::{
    transaction::Transactable, ActorId, AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc, Value,
    ROOT,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;
use uuid::Uuid;

pub const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 128 * 1024;
const MAX_NOTES: usize = 2000;
const MAX_PEERS: usize = 64;
const INVITE_PREFIX: &str = "murmur://join#";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub network: Option<NetworkView>,
    pub notes: Vec<Note>,
    pub files: Vec<SharedFile>,
    pub heads: Vec<String>,
    pub status: SyncStatus,
    pub device_id: String,
    pub listener_port: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

impl Theme {
    fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Settings {
    pub theme: Theme,
}
#[derive(Clone, Serialize)]
pub struct NetworkView {
    pub id: String,
    pub name: String,
    pub invite: String,
    pub phrase: String,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub updated_at: u64,
    pub tags: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftBackup {
    pub network_id: String,
    pub id: String,
    pub title: String,
    pub body: String,
    pub base_heads: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub peers: usize,
    pub last_sync: Option<u64>,
    pub error: Option<String>,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device_id: String,
    pub network_id: String,
    pub addresses: Vec<String>,
    pub port: u16,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Network {
    v: u8,
    id: String,
    name: String,
    secret: String,
}
#[derive(Deserialize, Serialize)]
struct Config {
    v: u8,
    device_id: String,
    active_network: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct NetworkDisk {
    network: Network,
    document: String,
}
struct PeerState {
    peer: Peer,
    discovered: Instant,
    success: Option<Instant>,
}
struct State {
    store: Store,
    device_id: String,
    network: Option<Network>,
    doc: Option<AutoCommit>,
    peers: HashMap<String, PeerState>,
    last_sync: Option<u64>,
    error: Option<String>,
}
pub struct Engine {
    state: Mutex<State>,
    port: AtomicU16,
    pub(crate) sync_requested: Notify,
    pub(crate) files_requested: Notify,
}
pub(crate) struct SyncIdentity {
    pub network_id: String,
    pub secret: [u8; 32],
}
pub(crate) struct Packet {
    pub network_id: String,
    pub secret: [u8; 32],
    pub document: Vec<u8>,
}

impl Engine {
    pub fn open(directory: PathBuf) -> Result<Arc<Self>> {
        let mut store = Store::open(&directory)?;
        let config = match store.state()? {
            Some(config) => config,
            None => {
                let (config, networks) = read_legacy_store(&directory)?;
                store.initialize(&config, &networks)?;
                // The transaction above is committed before old files are moved.
                // Keep inert backups so upgrading can never destroy the old copy.
                archive_legacy_files(&directory, &networks);
                config
            }
        };
        validate_id(&config.device_id)?;
        let (network, doc) = if let Some(id) = &config.active_network_id {
            validate_id(id)?;
            let saved = store
                .network(id)?
                .ok_or("The active network is missing from SQLite.")?;
            let (network, doc) = decode_saved_network(saved)?;
            (Some(network), Some(doc))
        } else {
            (None, None)
        };
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                store,
                device_id: config.device_id,
                network,
                doc,
                peers: HashMap::new(),
                last_sync: None,
                error: None,
            }),
            port: AtomicU16::new(0),
            sync_requested: Notify::new(),
            files_requested: Notify::new(),
        }))
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| "The local note store is unavailable. Restart Murmur.".into())
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.snapshot_locked(&mut *self.state()?)
    }
    fn snapshot_locked(&self, s: &mut State) -> Result<Snapshot> {
        let (notes, file_records, heads) = if let Some(doc) = &mut s.doc {
            (
                read_notes(doc)?,
                files::read_files(doc)?,
                doc.get_heads().iter().map(ToString::to_string).collect(),
            )
        } else {
            (vec![], vec![], vec![])
        };
        let available: HashMap<String, u64> = match &s.network {
            Some(network) => s
                .store
                .blob_catalog(&network.id)?
                .into_iter()
                .map(|(hash, size)| u64::try_from(size).map(|size| (hash, size)).map_err(err))
                .collect::<Result<_>>()?,
            None => HashMap::new(),
        };
        let files = file_records
            .iter()
            .filter(|file| !file.deleted)
            .map(|file| file.view(available.get(&file.sha256) == Some(&file.size)))
            .collect();
        let network = match &s.network {
            Some(network) => Some(NetworkView {
                id: network.id.clone(),
                name: network.name.clone(),
                phrase: invitations::phrase(&network.id, &decode_secret(&network.secret)?)?,
                invite: format!(
                    "{INVITE_PREFIX}{}",
                    URL_SAFE_NO_PAD.encode(serde_json::to_vec(network).map_err(err)?)
                ),
            }),
            None => None,
        };
        Ok(Snapshot {
            network,
            notes,
            files,
            heads,
            status: SyncStatus {
                peers: s
                    .peers
                    .values()
                    .filter(|p| {
                        p.success
                            .is_some_and(|t| t.elapsed() < Duration::from_secs(30))
                    })
                    .count(),
                last_sync: s.last_sync,
                error: s.error.clone(),
            },
            device_id: s.device_id.clone(),
            listener_port: self.port.load(Ordering::Relaxed),
        })
    }

    pub fn create_network(&self, name: String) -> Result<Snapshot> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err("Give your network a name of 1–64 characters.".into());
        }
        let secret = rand::random::<[u8; 32]>();
        let network = Network {
            v: 1,
            id: invitations::network_id(&secret),
            name: name.into(),
            secret: URL_SAFE_NO_PAD.encode(secret),
        };
        let doc = genesis(&network.id)?;
        self.activate(network, doc)
    }

    pub fn join_network(&self, invite: String) -> Result<Snapshot> {
        let mut network = parse_invite(&invite)?;
        // Hold the same lock as edits/sync while restoring an archive, including
        // when rejoining the active network, so a merge cannot be overwritten.
        let mut state = self.state()?;
        let doc = if let Some(saved) = state.store.network(&network.id)? {
            let (old, doc) = decode_saved_network(saved)?;
            if old.secret != network.secret {
                return Err("This invitation has a different secret for a saved network.".into());
            }
            if !invite.trim().starts_with(INVITE_PREFIX) {
                network.name = old.name;
            }
            doc
        } else {
            genesis(&network.id)?
        };
        self.activate_locked(&mut state, network, doc)
    }

    fn activate(&self, network: Network, doc: AutoCommit) -> Result<Snapshot> {
        self.activate_locked(&mut *self.state()?, network, doc)
    }
    fn activate_locked(
        &self,
        s: &mut State,
        network: Network,
        mut doc: AutoCommit,
    ) -> Result<Snapshot> {
        save_network(&mut s.store, &network, &mut doc, true, None)?;
        s.network = Some(network);
        s.doc = Some(doc);
        s.peers.clear();
        s.last_sync = None;
        s.error = None;
        self.sync_requested.notify_one();
        self.files_requested.notify_one();
        self.snapshot_locked(s)
    }

    pub fn get_settings(&self) -> Result<Settings> {
        let theme = match self.state()?.store.theme()?.as_str() {
            "system" => Theme::System,
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            _ => return Err("The saved theme is not supported.".into()),
        };
        Ok(Settings { theme })
    }

    pub(crate) fn stage_incoming(&self, shares: &[QueuedShare]) -> Result<()> {
        incoming::validate(shares)?;
        self.state()?.store.stage_shares(shares)
    }

    pub fn pending_shares(&self) -> Result<Vec<PendingShare>> {
        self.state()?.store.pending_shares()
    }

    pub fn discard_pending_shares(&self) -> Result<()> {
        self.state()?.store.discard_pending_shares()
    }

    pub fn import_pending_shares(&self, network_id: String) -> Result<Snapshot> {
        let pending = {
            let mut state = self.state()?;
            ensure_active_network(&state, &network_id)?;
            state.store.pending_contents()?
        };
        incoming::validate(&pending)?;
        // Hash outside the state lock so typing/synchronization can continue.
        let prepared: Vec<_> = pending
            .into_iter()
            .map(|share| {
                let hash = files::content_hash(&share.content);
                (share, hash)
            })
            .collect();
        let mut state = self.state()?;
        ensure_active_network(&state, &network_id)?;
        let remaining: HashSet<_> = state
            .store
            .pending_shares()?
            .into_iter()
            .map(|item| item.id)
            .collect();
        let network = state
            .network
            .clone()
            .ok_or("Create or join a network first.")?;
        let mut doc = state
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        let mut blobs = Vec::new();
        let mut ids = Vec::new();
        for (share, hash) in prepared {
            if !remaining.contains(&share.id) {
                continue;
            }
            let size = u64::try_from(share.content.len()).map_err(err)?;
            files::add_file(
                &mut doc,
                &FileRecord {
                    id: Uuid::new_v4().to_string(),
                    name: share.name,
                    mime_type: share.mime_type,
                    size,
                    sha256: hash.clone(),
                    created_at: now(),
                    deleted: false,
                    tags: vec![],
                },
            )?;
            ids.push(share.id);
            blobs.push(StoredBlob {
                network_id: network.id.clone(),
                sha256: hash,
                size_bytes: i64::try_from(size).map_err(err)?,
                content: share.content,
            });
        }
        if ids.is_empty() {
            return self.snapshot_locked(&mut state);
        }
        validate_document(&doc, &network_id)?;
        let bytes = doc.save();
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err("This network has reached its history limit.".into());
        }
        state
            .store
            .import_pending_shares(&encode_saved_network(&network, bytes)?, &blobs, &ids)?;
        state.doc = Some(doc);
        self.sync_requested.notify_one();
        self.files_requested.notify_one();
        self.snapshot_locked(&mut state)
    }

    pub fn set_theme(&self, theme: Theme) -> Result<Settings> {
        self.state()?.store.set_theme(theme.name())?;
        Ok(Settings { theme })
    }

    pub fn import_file(
        &self,
        network_id: String,
        name: String,
        mime_type: String,
        data_base64: String,
    ) -> Result<Snapshot> {
        if data_base64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
            return Err("Choose a file no larger than 25 MiB.".into());
        }
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|_| "The file data is not valid base64.")?;
        self.import_file_bytes(network_id, name, mime_type, bytes)
    }

    pub fn import_file_bytes(
        &self,
        network_id: String,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<Snapshot> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err("Choose a file no larger than 25 MiB.".into());
        }
        let mime_type = if mime_type.is_empty() {
            "application/octet-stream".into()
        } else {
            mime_type
        };
        files::validate_name_mime(&name, &mime_type)?;
        let hash = files::content_hash(&bytes);
        let size = u64::try_from(bytes.len()).map_err(err)?;
        let mut state = self.state()?;
        ensure_active_network(&state, &network_id)?;
        let network = state
            .network
            .clone()
            .ok_or("Create or join a network first.")?;
        let mut doc = state
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        let file = FileRecord {
            id: Uuid::new_v4().to_string(),
            name,
            mime_type,
            size,
            sha256: hash.clone(),
            created_at: now(),
            deleted: false,
            tags: vec![],
        };
        files::add_file(&mut doc, &file)?;
        validate_document(&doc, &network.id)?;
        let blob = StoredBlob {
            network_id: network.id.clone(),
            sha256: hash,
            size_bytes: i64::try_from(size).map_err(err)?,
            content: bytes,
        };
        save_network_with_blob(
            &mut state.store,
            &network,
            &mut doc,
            false,
            None,
            Some(&blob),
        )?;
        state.doc = Some(doc);
        self.sync_requested.notify_one();
        self.files_requested.notify_one();
        self.snapshot_locked(&mut state)
    }

    pub fn read_file(&self, network_id: String, id: String) -> Result<FileContent> {
        let (name, mime_type, bytes) = self.read_file_bytes(network_id, id)?;
        Ok(FileContent {
            name,
            mime_type,
            data_base64: STANDARD.encode(bytes),
        })
    }

    pub fn read_file_bytes(
        &self,
        network_id: String,
        id: String,
    ) -> Result<(String, String, Vec<u8>)> {
        validate_id(&id)?;
        let (file, bytes) = {
            let mut state = self.state()?;
            ensure_active_network(&state, &network_id)?;
            let file = live_file(
                state.doc.as_ref().ok_or("The local document is missing.")?,
                &id,
            )?;
            let bytes = state
                .store
                .blob(&network_id, &file.sha256)?
                .ok_or("This file is waiting for a nearby device to send its content.")?
                .content;
            (file, bytes)
        };
        files::validate_content(&file.request(), &bytes)?;
        Ok((file.name, file.mime_type, bytes))
    }

    pub fn delete_file(&self, network_id: String, id: String) -> Result<Snapshot> {
        validate_id(&id)?;
        let mut state = self.state()?;
        ensure_active_network(&state, &network_id)?;
        let network = state
            .network
            .clone()
            .ok_or("Create or join a network first.")?;
        let mut doc = state
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        files::delete_file(&mut doc, &id)?;
        validate_document(&doc, &network.id)?;
        save_network(&mut state.store, &network, &mut doc, false, None)?;
        state.doc = Some(doc);
        self.sync_requested.notify_one();
        self.files_requested.notify_one();
        self.snapshot_locked(&mut state)
    }

    pub fn set_tag(
        &self,
        network_id: String,
        kind: TagKind,
        id: String,
        tag: String,
        present: bool,
    ) -> Result<Snapshot> {
        validate_id(&id)?;
        let mut state = self.state()?;
        ensure_active_network(&state, &network_id)?;
        let network = state
            .network
            .clone()
            .ok_or("Create or join a network first.")?;
        let mut doc = state
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        let object = match kind {
            TagKind::Note => {
                let object = note_object(&doc, &id)?;
                if is_deleted(&doc, &object)? {
                    return Err("This note was deleted.".into());
                }
                object
            }
            TagKind::File => {
                live_file(&doc, &id)?;
                files::file_object(&doc, &id)?
            }
        };
        if !tags::set(&mut doc, &object, &tag, present)? {
            return self.snapshot_locked(&mut state);
        }
        validate_document(&doc, &network_id)?;
        save_network(&mut state.store, &network, &mut doc, false, None)?;
        state.doc = Some(doc);
        self.sync_requested.notify_one();
        self.snapshot_locked(&mut state)
    }

    pub(crate) fn sync_identity(&self) -> Result<Option<SyncIdentity>> {
        self.state()?
            .network
            .as_ref()
            .map(|network| {
                Ok(SyncIdentity {
                    network_id: network.id.clone(),
                    secret: decode_secret(&network.secret)?,
                })
            })
            .transpose()
    }

    pub(crate) fn missing_files(&self, network_id: &str) -> Result<Vec<MissingFile>> {
        let mut state = self.state()?;
        ensure_active_network(&state, network_id)?;
        let files = files::read_files(state.doc.as_ref().ok_or("The local document is missing.")?)?;
        let available: HashMap<String, u64> = state
            .store
            .blob_catalog(network_id)?
            .into_iter()
            .map(|(hash, size)| u64::try_from(size).map(|size| (hash, size)).map_err(err))
            .collect::<Result<_>>()?;
        let mut seen = HashSet::new();
        Ok(files
            .iter()
            .filter(|file| {
                !file.deleted
                    && available.get(&file.sha256) != Some(&file.size)
                    && seen.insert(file.sha256.clone())
            })
            .map(FileRecord::request)
            .collect())
    }

    pub(crate) fn read_file_for_sync(
        &self,
        network_id: &str,
        request: &MissingFile,
    ) -> Result<Vec<u8>> {
        let bytes = {
            let mut state = self.state()?;
            ensure_active_network(&state, network_id)?;
            let file = live_file(
                state.doc.as_ref().ok_or("The local document is missing.")?,
                &request.id,
            )?;
            if file.request() != *request {
                return Err("The requested file metadata changed.".into());
            }
            state
                .store
                .blob(network_id, &request.sha256)?
                .ok_or("The file is not available on this device.")?
                .content
        };
        files::validate_content(request, &bytes)?;
        Ok(bytes)
    }

    pub(crate) fn accept_file(
        &self,
        network_id: &str,
        request: &MissingFile,
        bytes: &[u8],
    ) -> Result<()> {
        files::validate_content(request, bytes)?;
        let mut state = self.state()?;
        ensure_active_network(&state, network_id)?;
        let file = live_file(
            state.doc.as_ref().ok_or("The local document is missing.")?,
            &request.id,
        )?;
        if file.request() != *request {
            return Err("The file was changed or deleted while receiving it.".into());
        }
        state.store.save_blob(&StoredBlob {
            network_id: network_id.into(),
            sha256: request.sha256.clone(),
            size_bytes: i64::try_from(request.size).map_err(err)?,
            content: bytes.to_vec(),
        })?;
        self.files_requested.notify_one();
        Ok(())
    }

    pub fn create_note(&self) -> Result<Snapshot> {
        self.edit(|doc| {
            if doc.keys(ROOT).filter(|k| !k.starts_with('_')).count() >= MAX_NOTES {
                return Err("This network has reached its 2,000-note MVP limit.".into());
            }
            let id = Uuid::new_v4().to_string();
            let object = doc.put_object(ROOT, &id, ObjType::Map).map_err(err)?;
            doc.put_object(&object, "title", ObjType::Text)
                .map_err(err)?;
            doc.put_object(&object, "body", ObjType::Text)
                .map_err(err)?;
            doc.put(&object, "deleted", false).map_err(err)?;
            doc.put(&object, "updatedAt", now()).map_err(err)?;
            Ok(())
        })
    }

    /// Edit the revision displayed by the editor, then merge with the latest state.
    /// Applying the draft directly to the latest text could erase unseen peer edits.
    pub fn update_note(
        &self,
        id: String,
        title: String,
        body: String,
        base_heads: Vec<String>,
    ) -> Result<Snapshot> {
        validate_id(&id)?;
        if title.len() > 1024 || body.len() > MAX_BODY_BYTES {
            return Err("Keep the title below 1 KB and the note below 128 KB.".into());
        }
        if base_heads.is_empty() || base_heads.len() > 4096 {
            return Err("The editor revision is missing. Reopen this note.".into());
        }
        let heads: Vec<ChangeHash> = base_heads
            .iter()
            .map(|h| ChangeHash::from_str(h).map_err(err))
            .collect::<Result<_>>()?;
        let saved_draft = StoredDraft {
            network_id: self
                .state()?
                .network
                .as_ref()
                .ok_or("Create or join a network first.")?
                .id
                .clone(),
            note_id: id.clone(),
            title: title.clone(),
            body: body.clone(),
            base_heads: serde_json::to_string(&base_heads).map_err(err)?,
        };
        self.edit_with_recovery(Some(saved_draft), None, |doc| {
            let mut draft = doc
                .fork_at(&heads)
                .map_err(|_| "The editor revision is unavailable. Reopen this note.".to_string())?;
            let object = note_object(&draft, &id)?;
            if is_deleted(&draft, &object)? {
                return Err("This note was deleted.".into());
            }
            draft
                .update_text(&text_object(&draft, &object, "title")?, &title)
                .map_err(err)?;
            draft
                .update_text(&text_object(&draft, &object, "body")?, &body)
                .map_err(err)?;
            draft.put(&object, "updatedAt", now()).map_err(err)?;
            doc.merge(&mut draft).map_err(err)?;
            Ok(())
        })
    }

    pub fn delete_note(&self, id: String) -> Result<Snapshot> {
        validate_id(&id)?;
        self.edit_with_recovery(None, Some(&id), |doc| {
            let object = note_object(doc, &id)?;
            // Never remove the map: a concurrent edit cannot resurrect a deleted note.
            doc.put(&object, "deleted", true).map_err(err)?;
            doc.put(&object, "updatedAt", now()).map_err(err)?;
            Ok(())
        })
    }

    fn edit(&self, update: impl FnOnce(&mut AutoCommit) -> Result<()>) -> Result<Snapshot> {
        self.edit_with_recovery(None, None, update)
    }

    fn edit_with_recovery(
        &self,
        saved_draft: Option<StoredDraft>,
        deleted_note: Option<&str>,
        update: impl FnOnce(&mut AutoCommit) -> Result<()>,
    ) -> Result<Snapshot> {
        let mut s = self.state()?;
        let network = s.network.clone().ok_or("Create or join a network first.")?;
        if saved_draft
            .as_ref()
            .is_some_and(|draft| draft.network_id != network.id)
        {
            return Err("The active network changed before the note was saved.".into());
        }
        let mut doc = s
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        update(&mut doc)?;
        validate_document(&doc, &network.id)?;
        let draft_clear = match saved_draft.as_ref() {
            Some(draft) => Some(DraftClear::Saved(draft)),
            None => deleted_note.map(DraftClear::DeletedNote),
        };
        save_network(&mut s.store, &network, &mut doc, false, draft_clear)?;
        s.doc = Some(doc);
        self.sync_requested.notify_one();
        self.snapshot_locked(&mut s)
    }

    pub fn get_draft(&self) -> Result<Option<DraftBackup>> {
        let mut state = self.state()?;
        let Some(network_id) = state.network.as_ref().map(|network| network.id.clone()) else {
            return Ok(None);
        };
        let Some(stored) = state.store.draft(&network_id)? else {
            return Ok(None);
        };
        let draft = DraftBackup {
            network_id: stored.network_id,
            id: stored.note_id,
            title: stored.title,
            body: stored.body,
            base_heads: serde_json::from_str(&stored.base_heads).map_err(err)?,
        };
        validate_draft(&draft)?;
        Ok(Some(draft))
    }

    pub fn save_draft(&self, draft: DraftBackup) -> Result<()> {
        self.persist_draft(draft, true)
    }

    pub fn import_draft(&self, draft: DraftBackup) -> Result<()> {
        self.persist_draft(draft, false)
    }

    fn persist_draft(&self, draft: DraftBackup, replace: bool) -> Result<()> {
        validate_draft(&draft)?;
        let mut state = self.state()?;
        let mut doc = if state
            .network
            .as_ref()
            .is_some_and(|network| network.id == draft.network_id)
        {
            state
                .doc
                .as_ref()
                .ok_or("The local document is missing.")?
                .clone()
        } else {
            let saved = state
                .store
                .network(&draft.network_id)?
                .ok_or("The draft network is not saved on this device.")?;
            decode_saved_network(saved)?.1
        };
        let heads = draft
            .base_heads
            .iter()
            .map(|head| ChangeHash::from_str(head).map_err(err))
            .collect::<Result<Vec<_>>>()?;
        let revision = doc
            .fork_at(&heads)
            .map_err(|_| "The draft revision is unavailable.")?;
        // The note may have been deleted on another peer since this revision.
        // Preserve the unsaved text for recovery rather than discarding it.
        note_object(&revision, &draft.id)?;
        state.store.save_draft(
            &StoredDraft {
                network_id: draft.network_id,
                note_id: draft.id,
                title: draft.title,
                body: draft.body,
                base_heads: serde_json::to_string(&draft.base_heads).map_err(err)?,
            },
            replace,
        )
    }

    pub fn clear_draft(&self, network_id: String, id: String) -> Result<()> {
        validate_id(&network_id)?;
        validate_id(&id)?;
        self.state()?.store.clear_draft(&network_id, &id)
    }

    pub fn peer_discovered(&self, mut peer: Peer) -> Result<()> {
        let mut s = self.state()?;
        validate_id(&peer.device_id)?;
        if peer.port == 0 || peer.addresses.len() > 32 {
            return Err("Invalid peer address.".into());
        }
        if s.network.as_ref().is_none_or(|n| n.id != peer.network_id)
            || peer.device_id == s.device_id
        {
            return Ok(());
        }
        // Accept numeric unicast addresses only: discovery must not become arbitrary DNS/URL access.
        peer.addresses.retain(|a| valid_peer_address(a));
        peer.addresses.sort();
        peer.addresses.dedup();
        if peer.addresses.is_empty() {
            return Ok(());
        }
        if s.peers.len() >= MAX_PEERS && !s.peers.contains_key(&peer.device_id) {
            return Ok(());
        }
        let old_success = s.peers.get(&peer.device_id).and_then(|p| p.success);
        s.peers.insert(
            peer.device_id.clone(),
            PeerState {
                peer,
                discovered: Instant::now(),
                success: old_success,
            },
        );
        self.sync_requested.notify_one();
        Ok(())
    }

    pub fn request_sync(&self) -> Result<Snapshot> {
        self.sync_requested.notify_one();
        self.snapshot()
    }
    pub(crate) fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }
    pub(crate) fn peers(&self) -> Vec<Peer> {
        self.state()
            .map(|mut s| {
                s.peers.retain(|_, p| {
                    p.discovered.elapsed() < Duration::from_secs(10 * 60)
                        || p.success
                            .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
                });
                s.peers.values().map(|p| p.peer.clone()).collect()
            })
            .unwrap_or_default()
    }
    pub(crate) fn packet(&self) -> Result<Option<Packet>> {
        let mut s = self.state()?;
        let Some(network) = s.network.clone() else {
            return Ok(None);
        };
        let document = s.doc.as_mut().ok_or("Missing document")?.save();
        if document.len() > MAX_DOCUMENT_BYTES {
            return Err("This network exceeds the 8 MB MVP sync limit.".into());
        }
        Ok(Some(Packet {
            network_id: network.id,
            secret: decode_secret(&network.secret)?,
            document,
        }))
    }
    pub(crate) fn accept_document(&self, network_id: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err("Peer document exceeds the sync limit.".into());
        }
        let mut incoming =
            AutoCommit::load(bytes).map_err(|_| "Peer sent an invalid document.".to_string())?;
        validate_document(&incoming, network_id)?;
        let mut s = self.state()?;
        let network = s
            .network
            .clone()
            .filter(|n| n.id == network_id)
            .ok_or("The active network changed.")?;
        let mut doc = s.doc.as_ref().ok_or("Missing local document")?.clone();
        let before = doc.get_heads();
        doc.merge(&mut incoming).map_err(err)?;
        validate_document(&doc, network_id)?;
        let bytes = if before != doc.get_heads() {
            let bytes = save_network(&mut s.store, &network, &mut doc, false, None)?;
            s.doc = Some(doc);
            // Relay newly received changes to other nearby peers promptly.
            self.sync_requested.notify_one();
            self.files_requested.notify_one();
            bytes
        } else {
            doc.save()
        };
        s.last_sync = Some(now());
        s.error = None;
        Ok(bytes)
    }
    pub(crate) fn sync_result(&self, peer: &Peer, result: std::result::Result<(), String>) {
        if let Ok(mut s) = self.state() {
            if s.network.as_ref().is_none_or(|n| n.id != peer.network_id) {
                return;
            }
            if result.is_ok() {
                if let Some(p) = s.peers.get_mut(&peer.device_id) {
                    p.success = Some(Instant::now());
                }
                s.last_sync = Some(now());
                s.error = None;
            } else if !s.peers.values().any(|p| {
                p.success
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(30))
            }) {
                s.error = Some(
                    "A nearby device is unreachable. Notes are saved here; Murmur will retry."
                        .into(),
                );
            }
        }
    }
}

fn genesis(id: &str) -> Result<AutoCommit> {
    // Every member constructs byte-identical initial changes. Do not create a
    // separate `notes` map on each device, which would produce conflicting maps.
    let mut doc = AutoCommit::new().with_actor(ActorId::from([0u8; 16].as_slice()));
    doc.put(ROOT, "_network", id).map_err(err)?;
    doc.put(ROOT, "_schema", 1u64).map_err(err)?;
    doc.commit();
    doc.set_actor(ActorId::from(Uuid::new_v4().as_bytes().as_slice()));
    Ok(doc)
}
fn ensure_active_network(state: &State, network_id: &str) -> Result<()> {
    if state
        .network
        .as_ref()
        .is_none_or(|network| network.id != network_id)
    {
        return Err("The active network changed.".into());
    }
    Ok(())
}

fn live_file(doc: &AutoCommit, id: &str) -> Result<FileRecord> {
    validate_id(id)?;
    files::read_files(doc)?
        .into_iter()
        .find(|file| file.id == id && !file.deleted)
        .ok_or("This shared file was deleted or no longer exists.".into())
}
fn note_object(doc: &AutoCommit, id: &str) -> Result<ObjId> {
    match doc.get(ROOT, id).map_err(err)? {
        Some((Value::Object(ObjType::Map), object)) => Ok(object),
        _ => Err("This note no longer exists.".into()),
    }
}
fn text_object(doc: &AutoCommit, note: &ObjId, field: &str) -> Result<ObjId> {
    match doc.get(note, field).map_err(err)? {
        Some((Value::Object(ObjType::Text), object)) => Ok(object),
        _ => Err("Invalid note text.".into()),
    }
}
fn is_deleted(doc: &AutoCommit, note: &ObjId) -> Result<bool> {
    Ok(doc
        .get_all(note, "deleted")
        .map_err(err)?
        .iter()
        .any(|(v, _)| v.as_bool() == Some(true)))
}
fn read_notes(doc: &AutoCommit) -> Result<Vec<Note>> {
    let mut notes = Vec::new();
    for id in doc.keys(ROOT).filter(|id| !id.starts_with('_')) {
        let object = note_object(doc, &id)?;
        if is_deleted(doc, &object)? {
            continue;
        }
        let title = doc.text(text_object(doc, &object, "title")?).map_err(err)?;
        let body = doc.text(text_object(doc, &object, "body")?).map_err(err)?;
        let updated_at = doc
            .get_all(&object, "updatedAt")
            .map_err(err)?
            .iter()
            .filter_map(|(v, _)| v.as_u64())
            .max()
            .unwrap_or(0);
        notes.push(Note {
            id,
            title,
            body,
            updated_at,
            tags: tags::read(doc, &object)?,
        });
    }
    notes.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(notes)
}
fn validate_document(doc: &AutoCommit, network_id: &str) -> Result<()> {
    let ids = doc.get_all(ROOT, "_network").map_err(err)?;
    if ids.len() != 1 || ids[0].0.as_str() != Some(network_id) {
        return Err("The peer document belongs to another network.".into());
    }
    if doc
        .get(ROOT, "_schema")
        .map_err(err)?
        .and_then(|(v, _)| v.as_u64())
        != Some(1)
    {
        return Err("Unsupported note format.".into());
    }
    if doc.keys(ROOT).count() > MAX_NOTES + 2 {
        return Err("Too many notes in this network.".into());
    }
    files::read_files(doc)?;
    for id in doc.keys(ROOT).filter(|id| !id.starts_with('_')) {
        validate_id(&id)?;
        let object = note_object(doc, &id)?;
        tags::read(doc, &object)?;
        if doc
            .text(text_object(doc, &object, "title")?)
            .map_err(err)?
            .len()
            > 1024
            || doc
                .text(text_object(doc, &object, "body")?)
                .map_err(err)?
                .len()
                > MAX_BODY_BYTES
        {
            return Err("A peer note exceeds the size limit.".into());
        }
    }
    Ok(())
}
fn parse_invite(invite: &str) -> Result<Network> {
    let invite = invite.trim();
    if invite.len() > 4096 {
        return Err("This invitation is too large.".into());
    }
    if !invite.starts_with(INVITE_PREFIX) {
        let (id, secret) = invitations::parse(invite)?;
        return Ok(Network {
            v: 1,
            id,
            name: "Shared network".into(),
            secret: URL_SAFE_NO_PAD.encode(secret),
        });
    }
    let encoded = invite
        .strip_prefix(INVITE_PREFIX)
        .ok_or("This is not a Murmur invitation.")?;
    let network: Network = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Invalid invitation encoding.")?,
    )
    .map_err(|_| "Invalid Murmur invitation.".to_string())?;
    validate_network(&network)?;
    Ok(network)
}
fn validate_network(network: &Network) -> Result<()> {
    if network.v != 1 {
        return Err("This invitation needs a newer version of Murmur.".into());
    }
    validate_id(&network.id)?;
    if network.name.trim().is_empty() || network.name.chars().count() > 64 {
        return Err("Invalid network name.".into());
    }
    decode_secret(&network.secret)?;
    Ok(())
}
fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id)
        .map_err(|_| "Invalid network or note ID.")?
        .to_string()
        != id
    {
        return Err("Invalid network or note ID.".into());
    }
    Ok(())
}
fn decode_secret(secret: &str) -> Result<[u8; 32]> {
    URL_SAFE_NO_PAD
        .decode(secret)
        .map_err(|_| "Invalid network secret.".to_string())?
        .try_into()
        .map_err(|_| "Invalid network secret.".into())
}
fn valid_peer_address(address: &str) -> bool {
    // Numeric IPv6 zone identifiers are supported for link-local interfaces.
    let (host, scoped) = match address.split_once('%') {
        Some((host, scope)) if scope.parse::<u32>().is_ok_and(|index| index != 0) => (host, true),
        Some(_) => return false,
        None => (address, false),
    };
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    match ip {
        // A peer on the same LAN may have a globally scoped IPv6 or public IPv4
        // address. mDNS establishes proximity; RFC1918 ranges do not.
        IpAddr::V4(v) => !scoped && !v.is_unspecified() && !v.is_multicast() && !v.is_broadcast(),
        IpAddr::V6(v) => !v.is_unspecified() && !v.is_multicast(),
    }
}
fn network_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("network-{id}.json"))
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let length = fs::metadata(path).map_err(err)?.len();
    if length > u64::try_from(limit).map_err(err)? {
        return Err("Saved data exceeds the MVP size limit.".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if bytes.len() > limit {
        return Err("Saved data exceeds the MVP size limit.".into());
    }
    Ok(bytes)
}
fn read_legacy_network(directory: &Path, id: &str) -> Result<StoredNetwork> {
    let bytes = read_bounded(&network_path(directory, id), MAX_DOCUMENT_BYTES * 2)?;
    let disk: NetworkDisk = serde_json::from_slice(&bytes).map_err(err)?;
    validate_network(&disk.network)?;
    if disk.network.id != id {
        return Err("Saved network ID does not match.".into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(&disk.document).map_err(err)?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("Saved network exceeds the MVP size limit.".into());
    }
    let doc = AutoCommit::load(&bytes).map_err(err)?;
    validate_document(&doc, id)?;
    encode_saved_network(&disk.network, bytes)
}
fn read_legacy_store(directory: &Path) -> Result<(StoredState, Vec<StoredNetwork>)> {
    let mut networks = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(id) = name
            .strip_prefix("network-")
            .and_then(|name| name.strip_suffix(".json"))
        {
            validate_id(id)?;
            networks.push(read_legacy_network(directory, id)?);
        }
    }
    let config_path = directory.join("state.json");
    let config: Config = if config_path.exists() {
        serde_json::from_slice(&read_bounded(&config_path, 4096)?).map_err(err)?
    } else if networks.is_empty() {
        Config {
            v: 1,
            device_id: Uuid::new_v4().to_string(),
            active_network: None,
        }
    } else {
        return Err(
            "Legacy network files exist but their device state is missing. No files were changed."
                .into(),
        );
    };
    if config.v != 1 {
        return Err("This local store is not supported.".into());
    }
    validate_id(&config.device_id)?;
    if let Some(id) = &config.active_network {
        validate_id(id)?;
        if !networks.iter().any(|network| &network.id == id) {
            return Err("The saved active network is missing. No files were changed.".into());
        }
    }
    Ok((
        StoredState {
            id: 1,
            device_id: config.device_id,
            active_network_id: config.active_network,
        },
        networks,
    ))
}
fn archive_legacy_files(directory: &Path, networks: &[StoredNetwork]) {
    let mut paths: Vec<PathBuf> = networks
        .iter()
        .map(|network| network_path(directory, &network.id))
        .collect();
    let config = directory.join("state.json");
    if config.exists() {
        paths.push(config);
    }
    if paths.is_empty() {
        return;
    }
    let backup = directory.join("legacy-json-backup");
    if fs::create_dir_all(&backup).is_err() {
        return;
    }
    for path in paths {
        if let Some(name) = path.file_name() {
            let destination = backup.join(name);
            if !destination.exists() {
                // Backup cleanup must not prevent opening the committed SQLite
                // store. Originals are left intact if the move is unavailable.
                let _ = fs::rename(&path, destination);
            }
        }
    }
}
fn encode_saved_network(network: &Network, document: Vec<u8>) -> Result<StoredNetwork> {
    Ok(StoredNetwork {
        id: network.id.clone(),
        name: network.name.clone(),
        protocol_version: i32::from(network.v),
        secret: decode_secret(&network.secret)?.to_vec(),
        document,
    })
}
fn decode_saved_network(saved: StoredNetwork) -> Result<(Network, AutoCommit)> {
    let network = Network {
        v: u8::try_from(saved.protocol_version).map_err(err)?,
        id: saved.id,
        name: saved.name,
        secret: URL_SAFE_NO_PAD.encode(saved.secret),
    };
    validate_network(&network)?;
    if saved.document.len() > MAX_DOCUMENT_BYTES {
        return Err("Saved network exceeds the MVP size limit.".into());
    }
    let mut doc = AutoCommit::load(&saved.document).map_err(err)?;
    validate_document(&doc, &network.id)?;
    doc.set_actor(ActorId::from(Uuid::new_v4().as_bytes().as_slice()));
    Ok((network, doc))
}
fn save_network(
    store: &mut Store,
    network: &Network,
    doc: &mut AutoCommit,
    activate: bool,
    draft_clear: Option<DraftClear<'_>>,
) -> Result<Vec<u8>> {
    save_network_with_blob(store, network, doc, activate, draft_clear, None)
}

fn save_network_with_blob(
    store: &mut Store,
    network: &Network,
    doc: &mut AutoCommit,
    activate: bool,
    draft_clear: Option<DraftClear<'_>>,
    blob: Option<&StoredBlob>,
) -> Result<Vec<u8>> {
    let live_hashes: Vec<String> = files::read_files(doc)?
        .into_iter()
        .filter(|file| !file.deleted)
        .map(|file| file.sha256)
        .collect();
    let bytes = doc.save();
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("This network has reached the 8 MB MVP limit.".into());
    }
    store.save_network(
        &encode_saved_network(network, bytes.clone())?,
        activate,
        draft_clear,
        blob,
        &live_hashes,
    )?;
    Ok(bytes)
}
fn validate_draft(draft: &DraftBackup) -> Result<()> {
    validate_id(&draft.network_id)?;
    validate_id(&draft.id)?;
    if draft.title.len() > 1024 || draft.body.len() > MAX_BODY_BYTES {
        return Err("Keep the title below 1 KB and the note below 128 KB.".into());
    }
    if draft.base_heads.is_empty() || draft.base_heads.len() > 4096 {
        return Err("The draft revision is missing or too large.".into());
    }
    for head in &draft.base_heads {
        ChangeHash::from_str(head).map_err(err)?;
    }
    Ok(())
}
fn now() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn active_network_id(engine: &Engine) -> String {
        engine.snapshot().unwrap().network.unwrap().id
    }
    fn pair() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<Engine>,
        Arc<Engine>,
    ) {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = Engine::open(a_dir.path().into()).unwrap();
        let b = Engine::open(b_dir.path().into()).unwrap();
        let snapshot = a.create_network("Kitchen".into()).unwrap();
        b.join_network(snapshot.network.unwrap().invite).unwrap();
        (a_dir, b_dir, a, b)
    }
    fn exchange(a: &Engine, b: &Engine) {
        let packet = a.packet().unwrap().unwrap();
        let response = b
            .accept_document(&packet.network_id, &packet.document)
            .unwrap();
        a.accept_document(&packet.network_id, &response).unwrap();
    }

    #[test]
    fn tags_persist_without_changing_file_bytes_or_overwriting_stale_note_edits() {
        let (directory, _db, a, _b) = pair();
        let note = a.create_note().unwrap().notes[0].clone();
        let network_id = active_network_id(&a);
        let file = a
            .import_file_bytes(
                network_id.clone(),
                "track.wav".into(),
                "audio/wav".into(),
                b"audio bytes".to_vec(),
            )
            .unwrap()
            .files[0]
            .clone();
        assert!(note.tags.is_empty());
        assert!(file.tags.is_empty());
        let before = a.snapshot().unwrap();
        let tagged = a
            .set_tag(
                network_id.clone(),
                TagKind::Note,
                note.id.clone(),
                "  Field   Notes  ".into(),
                true,
            )
            .unwrap();
        assert_eq!(tagged.notes[0].tags, ["field notes"]);
        assert_eq!(tagged.notes[0].updated_at, note.updated_at);
        let tagged = a
            .set_tag(
                network_id.clone(),
                TagKind::File,
                file.id.clone(),
                "Music".into(),
                true,
            )
            .unwrap();
        assert_eq!(tagged.files[0].tags, ["music"]);
        assert_eq!(tagged.files[0].sha256, file.sha256);
        assert_eq!(tagged.files[0].created_at, file.created_at);
        let saved = a
            .update_note(
                note.id.clone(),
                "Markdown session".into(),
                "# Still editing\n\nA new paragraph.".into(),
                before.heads,
            )
            .unwrap();
        assert_eq!(saved.notes[0].tags, ["field notes"]);
        assert_eq!(saved.notes[0].body, "# Still editing\n\nA new paragraph.");
        assert_eq!(
            a.read_file_bytes(network_id.clone(), file.id.clone())
                .unwrap()
                .2,
            b"audio bytes"
        );
        let heads = saved.heads;
        let unchanged = a
            .set_tag(
                network_id,
                TagKind::Note,
                note.id,
                "FIELD NOTES".into(),
                true,
            )
            .unwrap();
        assert_eq!(unchanged.heads, heads);
        drop(a);
        let reopened = Engine::open(directory.path().into())
            .unwrap()
            .snapshot()
            .unwrap();
        assert_eq!(reopened.notes[0].tags, ["field notes"]);
        assert_eq!(reopened.files[0].tags, ["music"]);
        assert!(reopened.files[0].available);
    }

    #[test]
    fn concurrent_note_and_file_tags_merge_and_deletions_stay_deleted() {
        let (_da, _db, a, b) = pair();
        let network_id = active_network_id(&a);
        let note_id = a.create_note().unwrap().notes[0].id.clone();
        let file_id = a
            .import_file_bytes(
                network_id.clone(),
                "waiting.txt".into(),
                "text/plain".into(),
                b"hello".to_vec(),
            )
            .unwrap()
            .files[0]
            .id
            .clone();
        exchange(&a, &b);
        assert!(!b.snapshot().unwrap().files[0].available);
        for (kind, id) in [(TagKind::Note, &note_id), (TagKind::File, &file_id)] {
            a.set_tag(network_id.clone(), kind, id.clone(), "alpha".into(), true)
                .unwrap();
            b.set_tag(network_id.clone(), kind, id.clone(), "beta".into(), true)
                .unwrap();
        }
        exchange(&a, &b);
        for snapshot in [a.snapshot().unwrap(), b.snapshot().unwrap()] {
            assert_eq!(snapshot.notes[0].tags, ["alpha", "beta"]);
            assert_eq!(snapshot.files[0].tags, ["alpha", "beta"]);
        }
        for (kind, id) in [(TagKind::Note, &note_id), (TagKind::File, &file_id)] {
            a.set_tag(network_id.clone(), kind, id.clone(), "alpha".into(), false)
                .unwrap();
            b.set_tag(network_id.clone(), kind, id.clone(), "gamma".into(), true)
                .unwrap();
        }
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().notes[0].tags, ["beta", "gamma"]);
        assert_eq!(a.snapshot().unwrap().files[0].tags, ["beta", "gamma"]);
        a.delete_note(note_id.clone()).unwrap();
        a.delete_file(network_id.clone(), file_id.clone()).unwrap();
        b.set_tag(
            network_id.clone(),
            TagKind::Note,
            note_id.clone(),
            "delta".into(),
            true,
        )
        .unwrap();
        b.set_tag(
            network_id.clone(),
            TagKind::File,
            file_id.clone(),
            "delta".into(),
            true,
        )
        .unwrap();
        exchange(&a, &b);
        for engine in [&a, &b] {
            let snapshot = engine.snapshot().unwrap();
            assert!(snapshot.notes.is_empty());
            assert!(snapshot.files.is_empty());
            assert!(engine
                .set_tag(
                    network_id.clone(),
                    TagKind::Note,
                    note_id.clone(),
                    "later".into(),
                    true
                )
                .is_err());
            assert!(engine
                .set_tag(
                    network_id.clone(),
                    TagKind::File,
                    file_id.clone(),
                    "later".into(),
                    true
                )
                .is_err());
        }
    }

    #[test]
    fn concurrent_additions_at_the_tag_limit_merge_and_remain_removable() {
        let (_da, _db, a, b) = pair();
        let network_id = active_network_id(&a);
        let id = a.create_note().unwrap().notes[0].id.clone();
        for index in 0..31 {
            a.set_tag(
                network_id.clone(),
                TagKind::Note,
                id.clone(),
                format!("tag {index}"),
                true,
            )
            .unwrap();
        }
        exchange(&a, &b);
        a.set_tag(
            network_id.clone(),
            TagKind::Note,
            id.clone(),
            "local".into(),
            true,
        )
        .unwrap();
        b.set_tag(
            network_id.clone(),
            TagKind::Note,
            id.clone(),
            "remote".into(),
            true,
        )
        .unwrap();
        assert!(a
            .set_tag(
                network_id.clone(),
                TagKind::Note,
                id.clone(),
                "too many".into(),
                true
            )
            .is_err());
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().notes[0].tags.len(), 33);
        let removed = a
            .set_tag(network_id, TagKind::Note, id, "local".into(), false)
            .unwrap();
        assert_eq!(removed.notes[0].tags.len(), 32);
        exchange(&a, &b);
        assert_eq!(
            a.snapshot().unwrap().notes[0].tags,
            b.snapshot().unwrap().notes[0].tags
        );
    }

    #[test]
    fn tags_reject_stale_networks_and_malformed_peer_metadata() {
        let (_da, _db, a, b) = pair();
        let network = a.snapshot().unwrap().network.unwrap();
        let id = a.create_note().unwrap().notes[0].id.clone();
        exchange(&a, &b);
        for tag in ["   ".to_owned(), "new\nline".to_owned(), "x".repeat(33)] {
            assert!(a
                .set_tag(network.id.clone(), TagKind::Note, id.clone(), tag, true)
                .is_err());
        }
        let packet = a.packet().unwrap().unwrap();
        for invalid_key in ["_tag:", "_tag:Noncanonical", "_tag:has\ncontrol"] {
            let mut malformed = AutoCommit::load(&packet.document).unwrap();
            let object = note_object(&malformed, &id).unwrap();
            malformed.put(&object, invalid_key, true).unwrap();
            assert!(b.accept_document(&network.id, &malformed.save()).is_err());
        }
        let mut malformed = AutoCommit::load(&packet.document).unwrap();
        let object = note_object(&malformed, &id).unwrap();
        malformed
            .put(&object, "_tag:work", "not a boolean")
            .unwrap();
        assert!(b.accept_document(&network.id, &malformed.save()).is_err());
        assert!(b.snapshot().unwrap().notes[0].tags.is_empty());
        a.create_network("Other network".into()).unwrap();
        assert!(a
            .set_tag(
                network.id.clone(),
                TagKind::Note,
                id.clone(),
                "private".into(),
                true
            )
            .is_err());
        assert!(a.join_network(network.invite).unwrap().notes[0]
            .tags
            .is_empty());
    }
    #[test]
    fn word_invitation_joins_offline_and_preserves_saved_network_names() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = Engine::open(a_dir.path().into()).unwrap();
        let b = Engine::open(b_dir.path().into()).unwrap();
        let network = a.create_network("Kitchen".into()).unwrap().network.unwrap();
        assert_eq!(network.phrase.split_whitespace().count(), 24);
        let joined = b.join_network(network.phrase.clone()).unwrap();
        assert_eq!(joined.network.unwrap().id, network.id);
        // Joining requires no discovery, server, or online phrase lookup.
        b.create_note().unwrap();
        a.create_note().unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().notes.len(), 2);
        a.create_network("Other".into()).unwrap();
        let restored = a.join_network(network.phrase).unwrap();
        assert_eq!(restored.network.unwrap().name, "Kitchen");
        assert_eq!(restored.notes.len(), 2);
        assert_eq!(parse_invite(&network.invite).unwrap().id, network.id);
    }

    #[test]
    fn legacy_network_word_invitation_keeps_existing_notes_and_key() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = Engine::open(a_dir.path().into()).unwrap();
        let b = Engine::open(b_dir.path().into()).unwrap();
        let network = Network {
            v: 1,
            id: Uuid::new_v4().to_string(),
            name: "Existing network".into(),
            secret: URL_SAFE_NO_PAD.encode([81u8; 32]),
        };
        a.activate(network.clone(), genesis(&network.id).unwrap())
            .unwrap();
        a.create_note().unwrap();
        let phrase = a.snapshot().unwrap().network.unwrap().phrase;
        assert_eq!(phrase.split_whitespace().count(), 36);
        b.join_network(phrase).unwrap();
        assert_eq!(
            a.packet().unwrap().unwrap().secret,
            b.packet().unwrap().unwrap().secret
        );
        exchange(&a, &b);
        assert_eq!(b.snapshot().unwrap().notes.len(), 1);
    }
    #[test]
    fn independent_creation_and_offline_text_edits_converge() {
        let (_da, _db, a, b) = pair();
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        a.update_note(id.clone(), "Shopping".into(), "tea".into(), first.heads)
            .unwrap();
        b.create_note().unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().notes.len(), 2);
        let a_before = a.snapshot().unwrap();
        let b_before = b.snapshot().unwrap();
        a.update_note(
            id.clone(),
            "Shopping".into(),
            "green tea".into(),
            a_before.heads,
        )
        .unwrap();
        b.update_note(
            id.clone(),
            "Shopping".into(),
            "tea and milk".into(),
            b_before.heads,
        )
        .unwrap();
        exchange(&a, &b);
        let an = a
            .snapshot()
            .unwrap()
            .notes
            .into_iter()
            .find(|n| n.id == id)
            .unwrap();
        let bn = b
            .snapshot()
            .unwrap()
            .notes
            .into_iter()
            .find(|n| n.id == id)
            .unwrap();
        assert_eq!(an.body, "green tea and milk");
        assert_eq!(an.body, bn.body);
    }
    #[test]
    fn stale_editor_save_does_not_erase_already_received_peer_edit() {
        let (_da, _db, a, b) = pair();
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        a.update_note(id.clone(), "".into(), "tea".into(), first.heads)
            .unwrap();
        exchange(&a, &b);
        let stale = a.snapshot().unwrap();
        let remote = b.snapshot().unwrap();
        b.update_note(id.clone(), "".into(), "tea and milk".into(), remote.heads)
            .unwrap();
        exchange(&a, &b);
        a.update_note(id.clone(), "".into(), "green tea".into(), stale.heads)
            .unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().notes[0].body, "green tea and milk");
    }
    #[test]
    fn deletion_wins_concurrent_edit_and_survives_restart() {
        let (da, _db, a, b) = pair();
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        exchange(&a, &b);
        let old = b.snapshot().unwrap();
        a.delete_note(id.clone()).unwrap();
        b.update_note(id, "late".into(), "edit".into(), old.heads)
            .unwrap();
        exchange(&a, &b);
        assert!(a.snapshot().unwrap().notes.is_empty());
        let restarted = Engine::open(da.path().into()).unwrap();
        assert!(restarted.snapshot().unwrap().notes.is_empty());
        assert_eq!(
            a.snapshot().unwrap().network.unwrap().id,
            restarted.snapshot().unwrap().network.unwrap().id
        );
    }
    #[test]
    fn switch_archives_network_and_rejoin_restores_notes() {
        let (_da, _db, a, _b) = pair();
        let invite = a.snapshot().unwrap().network.unwrap().invite;
        a.create_note().unwrap();
        a.create_network("Other".into()).unwrap();
        assert!(a.snapshot().unwrap().notes.is_empty());
        a.join_network(invite).unwrap();
        assert_eq!(a.snapshot().unwrap().notes.len(), 1);
    }
    #[test]
    fn invalid_invites_and_cross_network_documents_are_rejected() {
        let (_da, _db, a, b) = pair();
        for invite in [
            "https://example.com",
            "murmur://join#bad",
            "",
            "murmur://join#e30",
        ] {
            assert!(b.join_network(invite.into()).is_err());
        }
        let packet = a.packet().unwrap().unwrap();
        b.create_network("Unrelated".into()).unwrap();
        assert!(b
            .accept_document(&packet.network_id, &packet.document)
            .is_err());
        assert!(b
            .accept_document(&b.packet().unwrap().unwrap().network_id, &packet.document)
            .is_err());
    }
    #[test]
    fn offline_edits_and_revision_heads_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let a = Engine::open(directory.path().into()).unwrap();
        let network = a.create_network("Offline".into()).unwrap().network.unwrap();
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        let saved = a
            .update_note(
                id.clone(),
                "Åben café ☕".into(),
                "remember\nαβγ 👩‍💻".into(),
                first.heads,
            )
            .unwrap();
        let device_id = saved.device_id.clone();
        let heads = saved.heads.clone();
        drop(a);
        let restarted = Engine::open(directory.path().into()).unwrap();
        let recovered = restarted.snapshot().unwrap();
        assert_eq!(recovered.device_id, device_id);
        assert_eq!(recovered.network.unwrap().invite, network.invite);
        assert_eq!(recovered.notes[0].title, "Åben café ☕");
        assert_eq!(recovered.notes[0].body, "remember\nαβγ 👩‍💻");
        assert_eq!(recovered.heads, heads);
        // A backed-up editor draft can still save against pre-restart heads.
        let updated = restarted
            .update_note(
                id,
                "Åben café ☕".into(),
                "remember\nαβγ 👩‍💻\nand milk".into(),
                heads,
            )
            .unwrap();
        assert_eq!(updated.notes[0].body, "remember\nαβγ 👩‍💻\nand milk");
    }
    #[test]
    fn sqlite_migrates_identity_active_network_and_archives_without_losing_history() {
        let directory = tempfile::tempdir().unwrap();
        let device_id = Uuid::new_v4().to_string();
        let (active, mut active_doc) = legacy_network(directory.path(), "Current", "current text");
        let (archived, _) = legacy_network(directory.path(), "Archived", "archived text");
        let active_heads = active_doc.get_heads();
        legacy_config(directory.path(), &device_id, Some(active.id.clone()));

        let engine = Engine::open(directory.path().into()).unwrap();
        let snapshot = engine.snapshot().unwrap();
        assert_eq!(snapshot.device_id, device_id);
        assert_eq!(snapshot.network.unwrap().id, active.id);
        assert_eq!(snapshot.notes[0].body, "current text");
        assert_eq!(
            snapshot.heads,
            active_heads
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        );
        assert!(!directory.path().join("state.json").exists());
        assert!(!network_path(directory.path(), &archived.id).exists());
        assert!(directory
            .path()
            .join("legacy-json-backup/state.json")
            .is_file());
        let archived_invite = format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&archived).unwrap())
        );
        let reopened = engine.join_network(archived_invite.clone()).unwrap();
        assert_eq!(reopened.notes[0].body, "archived text");
        assert_eq!(reopened.network.unwrap().invite, archived_invite);
        drop(engine);
        let engine = Engine::open(directory.path().into()).unwrap();
        assert_eq!(engine.snapshot().unwrap().device_id, device_id);
        assert_eq!(engine.snapshot().unwrap().notes[0].body, "archived text");
        // Backups cannot become authoritative again after SQLite initialization.
        fs::write(directory.path().join("state.json"), b"corrupt stale backup").unwrap();
        assert!(Engine::open(directory.path().into()).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(directory.path()).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("murmur.sqlite3"))
                {
                    assert_eq!(
                        entry.metadata().unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
            }
        }
    }

    #[test]
    fn failed_legacy_migration_keeps_every_original_and_can_be_retried() {
        let directory = tempfile::tempdir().unwrap();
        let (active, _) = legacy_network(directory.path(), "Current", "keep me");
        let (archived, _) = legacy_network(directory.path(), "Archive", "keep archive");
        legacy_config(
            directory.path(),
            &Uuid::new_v4().to_string(),
            Some(active.id.clone()),
        );
        let archive_path = network_path(directory.path(), &archived.id);
        let original = fs::read(&archive_path).unwrap();
        fs::write(&archive_path, b"broken JSON").unwrap();
        assert!(Engine::open(directory.path().into()).is_err());
        assert!(directory.path().join("state.json").exists());
        assert!(network_path(directory.path(), &active.id).exists());
        assert_eq!(fs::read(&archive_path).unwrap(), b"broken JSON");
        let mut store = Store::open(directory.path()).unwrap();
        assert!(store.state().unwrap().is_none());
        assert!(store.network(&active.id).unwrap().is_none());
        drop(store);
        fs::write(archive_path, original).unwrap();
        let restored = Engine::open(directory.path().into()).unwrap();
        assert_eq!(restored.snapshot().unwrap().notes[0].body, "keep me");
    }

    #[test]
    fn sqlite_initialization_rolls_back_all_networks_on_transaction_failure() {
        let directory = tempfile::tempdir().unwrap();
        let (network, mut doc) = legacy_network(directory.path(), "Rollback", "unchanged");
        let mut store = Store::open(directory.path()).unwrap();
        let saved = encode_saved_network(&network, doc.save()).unwrap();
        let invalid_state = StoredState {
            id: 1,
            device_id: Uuid::new_v4().to_string(),
            active_network_id: Some(Uuid::new_v4().to_string()),
        };
        assert!(store.initialize(&invalid_state, &[saved]).is_err());
        assert!(store.state().unwrap().is_none());
        assert!(store.network(&network.id).unwrap().is_none());
    }

    #[test]
    fn drafts_survive_restart_and_archive_switch_and_migration_never_replaces_newer_backup() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        let first_network = engine
            .create_network("First".into())
            .unwrap()
            .network
            .unwrap();
        let first_note = engine.create_note().unwrap();
        let mut draft = DraftBackup {
            network_id: first_network.id.clone(),
            id: first_note.notes[0].id.clone(),
            title: "Unsaved".into(),
            body: "recover this text".into(),
            base_heads: first_note.heads,
        };
        engine.save_draft(draft.clone()).unwrap();
        engine.create_network("Other".into()).unwrap();
        assert!(engine.get_draft().unwrap().is_none());
        draft.body = "late backup for archived network".into();
        engine.save_draft(draft.clone()).unwrap();
        engine.join_network(first_network.invite).unwrap();
        assert_eq!(engine.get_draft().unwrap(), Some(draft.clone()));
        let mut old = draft.clone();
        old.body = "old webview backup".into();
        engine.import_draft(old).unwrap();
        assert_eq!(engine.get_draft().unwrap(), Some(draft.clone()));
        engine
            .clear_draft(draft.network_id.clone(), Uuid::new_v4().to_string())
            .unwrap();
        assert_eq!(engine.get_draft().unwrap(), Some(draft.clone()));
        drop(engine);
        let engine = Engine::open(directory.path().into()).unwrap();
        assert_eq!(engine.get_draft().unwrap(), Some(draft.clone()));
        engine.clear_draft(draft.network_id, draft.id).unwrap();
        assert!(engine.get_draft().unwrap().is_none());
    }

    #[test]
    fn note_commit_atomically_clears_matching_draft_but_preserves_newer_keystrokes() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        let network = engine
            .create_network("Draft transactions".into())
            .unwrap()
            .network
            .unwrap();
        let snapshot = engine.create_note().unwrap();
        let draft = DraftBackup {
            network_id: network.id,
            id: snapshot.notes[0].id.clone(),
            title: "Saved".into(),
            body: "once".into(),
            base_heads: snapshot.heads,
        };
        engine.save_draft(draft.clone()).unwrap();
        let saved = engine
            .update_note(
                draft.id.clone(),
                draft.title.clone(),
                draft.body.clone(),
                draft.base_heads.clone(),
            )
            .unwrap();
        assert!(engine.get_draft().unwrap().is_none());
        let older = DraftBackup {
            body: "once, twice".into(),
            base_heads: saved.heads,
            ..draft
        };
        let newer = DraftBackup {
            body: "once, twice, three".into(),
            ..older.clone()
        };
        engine.save_draft(newer.clone()).unwrap();
        engine
            .update_note(older.id, older.title, older.body, older.base_heads)
            .unwrap();
        assert_eq!(engine.get_draft().unwrap(), Some(newer.clone()));
        let mut invalid = newer;
        invalid.base_heads = vec!["not a change hash".into()];
        assert!(engine.save_draft(invalid).is_err());
    }

    fn legacy_config(directory: &Path, device_id: &str, active_network: Option<String>) {
        fs::write(
            directory.join("state.json"),
            serde_json::to_vec(&Config {
                v: 1,
                device_id: device_id.into(),
                active_network,
            })
            .unwrap(),
        )
        .unwrap();
    }

    fn legacy_network(directory: &Path, name: &str, body: &str) -> (Network, AutoCommit) {
        let network = Network {
            v: 1,
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            secret: URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
        };
        let mut doc = genesis(&network.id).unwrap();
        let object = doc
            .put_object(ROOT, Uuid::new_v4().to_string(), ObjType::Map)
            .unwrap();
        let title = doc.put_object(&object, "title", ObjType::Text).unwrap();
        doc.update_text(&title, name).unwrap();
        let text = doc.put_object(&object, "body", ObjType::Text).unwrap();
        doc.update_text(&text, body).unwrap();
        doc.put(&object, "deleted", false).unwrap();
        doc.put(&object, "updatedAt", now()).unwrap();
        fs::write(
            network_path(directory, &network.id),
            serde_json::to_vec(&NetworkDisk {
                network: network.clone(),
                document: URL_SAFE_NO_PAD.encode(doc.save()),
            })
            .unwrap(),
        )
        .unwrap();
        (network, doc)
    }

    #[test]
    fn remote_deletion_preserves_recovery_but_local_deletion_clears_it_atomically() {
        let (_da, db, a, b) = pair();
        a.create_note().unwrap();
        exchange(&a, &b);
        let snapshot = b.snapshot().unwrap();
        let id = snapshot.notes[0].id.clone();
        let draft = DraftBackup {
            network_id: snapshot.network.unwrap().id,
            id: id.clone(),
            title: "Still editing".into(),
            body: "Keep this if a peer deletes the note".into(),
            base_heads: snapshot.heads,
        };
        b.save_draft(draft.clone()).unwrap();
        a.delete_note(id.clone()).unwrap();
        exchange(&a, &b);
        assert!(b.snapshot().unwrap().notes.is_empty());
        assert_eq!(b.get_draft().unwrap(), Some(draft));
        b.delete_note(id).unwrap();
        drop(b);
        let reopened = Engine::open(db.path().into()).unwrap();
        assert!(reopened.get_draft().unwrap().is_none());
        assert!(reopened.snapshot().unwrap().notes.is_empty());
    }

    #[test]
    fn shared_files_persist_deduplicate_and_delete_independently_of_notes() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        let network = engine
            .create_network("Files".into())
            .unwrap()
            .network
            .unwrap();
        engine.create_note().unwrap();
        let first = engine
            .import_file_bytes(
                active_network_id(&engine),
                "picture.png".into(),
                "image/png".into(),
                b"same content".to_vec(),
            )
            .unwrap();
        let first_id = first.files[0].id.clone();
        let second = engine
            .import_file_bytes(
                active_network_id(&engine),
                "copy.bin".into(),
                String::new(),
                b"same content".to_vec(),
            )
            .unwrap();
        let second_id = second
            .files
            .iter()
            .find(|file| file.id != first_id)
            .unwrap()
            .id
            .clone();
        assert_eq!(second.files.len(), 2);
        assert!(second.files.iter().all(|file| file.available));
        assert_eq!(second.notes.len(), 1);
        assert_eq!(
            engine
                .state()
                .unwrap()
                .store
                .blob_catalog(&network.id)
                .unwrap()
                .len(),
            1
        );
        drop(engine);
        let engine = Engine::open(directory.path().into()).unwrap();
        assert_eq!(engine.snapshot().unwrap().files.len(), 2);
        assert_eq!(
            engine
                .read_file_bytes(active_network_id(&engine), second_id.clone())
                .unwrap(),
            (
                "copy.bin".into(),
                "application/octet-stream".into(),
                b"same content".to_vec()
            )
        );
        engine
            .delete_file(active_network_id(&engine), first_id)
            .unwrap();
        assert_eq!(
            engine
                .state()
                .unwrap()
                .store
                .blob_catalog(&network.id)
                .unwrap()
                .len(),
            1
        );
        engine
            .delete_file(active_network_id(&engine), second_id)
            .unwrap();
        assert!(engine.snapshot().unwrap().files.is_empty());
        assert_eq!(engine.snapshot().unwrap().notes.len(), 1);
        assert!(engine
            .state()
            .unwrap()
            .store
            .blob_catalog(&network.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn concurrent_file_metadata_converges_and_tombstones_reject_stale_content() {
        let (_da, _db, a, b) = pair();
        let first = a
            .import_file_bytes(
                active_network_id(&a),
                "a.txt".into(),
                "text/plain".into(),
                b"first".to_vec(),
            )
            .unwrap();
        let second = b
            .import_file_bytes(
                active_network_id(&b),
                "b.txt".into(),
                "text/plain".into(),
                b"second".to_vec(),
            )
            .unwrap();
        let id = second.files[0].id.clone();
        let old_document = b.packet().unwrap().unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().files.len(), 2);
        assert_eq!(b.snapshot().unwrap().files.len(), 2);
        let network_id = first.network.unwrap().id;
        let request = a.missing_files(&network_id).unwrap().remove(0);
        assert_eq!(request.id, id);
        b.delete_file(active_network_id(&b), id).unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().files.len(), 1);
        assert!(a.accept_file(&network_id, &request, b"second").is_err());
        a.accept_document(&network_id, &old_document.document)
            .unwrap();
        assert_eq!(a.snapshot().unwrap().files.len(), 1);
        assert!(a.missing_files(&network_id).unwrap().is_empty());
    }

    #[test]
    fn received_files_require_exact_hash_size_and_network_and_become_available() {
        let (_da, _db, a, b) = pair();
        let snapshot = a
            .import_file_bytes(
                active_network_id(&a),
                "report.pdf".into(),
                "application/pdf".into(),
                b"sample data".to_vec(),
            )
            .unwrap();
        let network_id = snapshot.network.unwrap().id;
        let id = snapshot.files[0].id.clone();
        exchange(&a, &b);
        assert!(!b.snapshot().unwrap().files[0].available);
        assert!(b
            .read_file_bytes(active_network_id(&b), id.clone())
            .is_err());
        let request = b.missing_files(&network_id).unwrap().remove(0);
        assert!(b
            .accept_file(&network_id, &request, b"wrong bytes")
            .is_err());
        let invalid = MissingFile {
            size: request.size + 1,
            ..request.clone()
        };
        assert!(b
            .accept_file(&network_id, &invalid, b"sample data")
            .is_err());
        assert!(b
            .accept_file(&Uuid::new_v4().to_string(), &request, b"sample data")
            .is_err());
        b.accept_file(&network_id, &request, b"sample data")
            .unwrap();
        assert!(b.snapshot().unwrap().files[0].available);
        assert!(b.missing_files(&network_id).unwrap().is_empty());
        assert_eq!(
            b.read_file(active_network_id(&b), id.clone())
                .unwrap()
                .data_base64,
            STANDARD.encode(b"sample data")
        );
        b.create_network("Other".into()).unwrap();
        assert!(b.read_file_bytes(active_network_id(&b), id).is_err());
        assert!(b.read_file_for_sync(&network_id, &request).is_err());
        assert!(b
            .accept_file(&network_id, &request, b"sample data")
            .is_err());
    }

    #[test]
    fn file_limits_reject_invalid_content_and_oversized_peer_catalogs() {
        let (_da, _db, a, b) = pair();
        assert!(a
            .import_file_bytes(
                active_network_id(&a),
                "too-big.bin".into(),
                String::new(),
                vec![0; MAX_FILE_BYTES + 1]
            )
            .is_err());
        assert!(a
            .import_file_bytes(
                active_network_id(&a),
                "../escape.txt".into(),
                "text/plain".into(),
                vec![]
            )
            .is_err());
        assert!(a
            .import_file(
                active_network_id(&a),
                "bad.bin".into(),
                String::new(),
                "not base64".into()
            )
            .is_err());
        let packet = a.packet().unwrap().unwrap();
        let mut doc = AutoCommit::load(&packet.document).unwrap();
        for index in 0..11 {
            files::add_file(
                &mut doc,
                &FileRecord {
                    id: Uuid::new_v4().to_string(),
                    name: "file.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    size: u64::try_from(MAX_FILE_BYTES).unwrap(),
                    sha256: format!("{index:064x}"),
                    created_at: now(),
                    deleted: false,
                    tags: vec![],
                },
            )
            .unwrap();
        }
        assert!(b.accept_document(&packet.network_id, &doc.save()).is_err());
        assert!(b.snapshot().unwrap().files.is_empty());
        let mut doc = AutoCommit::load(&packet.document).unwrap();
        for _ in 0..501 {
            files::add_file(
                &mut doc,
                &FileRecord {
                    id: Uuid::new_v4().to_string(),
                    name: "empty.txt".into(),
                    mime_type: "text/plain".into(),
                    size: 0,
                    sha256: files::content_hash(&[]),
                    created_at: now(),
                    deleted: false,
                    tags: vec![],
                },
            )
            .unwrap();
        }
        assert!(b.accept_document(&packet.network_id, &doc.save()).is_err());
        assert!(b.snapshot().unwrap().files.is_empty());
    }

    #[test]
    fn theme_is_local_persistent_and_does_not_change_shared_genesis() {
        let (directory, _db, a, b) = pair();
        let before = a.snapshot().unwrap().heads;
        let packet = a.packet().unwrap().unwrap();
        let doc = AutoCommit::load(&packet.document).unwrap();
        assert_eq!(
            doc.keys(ROOT).collect::<Vec<_>>(),
            vec!["_network".to_string(), "_schema".to_string()]
        );
        assert_eq!(a.get_settings().unwrap().theme, Theme::System);
        a.set_theme(Theme::Dark).unwrap();
        exchange(&a, &b);
        assert_eq!(a.snapshot().unwrap().heads, before);
        assert_eq!(b.get_settings().unwrap().theme, Theme::System);
        drop(a);
        let reopened = Engine::open(directory.path().into()).unwrap();
        assert_eq!(reopened.get_settings().unwrap().theme, Theme::Dark);
        reopened.set_theme(Theme::Light).unwrap();
        assert_eq!(reopened.get_settings().unwrap().theme, Theme::Light);
        reopened.set_theme(Theme::System).unwrap();
        assert_eq!(reopened.get_settings().unwrap().theme, Theme::System);
    }

    #[test]
    fn file_settings_schema_upgrade_preserves_existing_sqlite_notes_and_history() {
        use diesel::Connection;
        use diesel_migrations::MigrationHarness;
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        engine
            .create_network("Existing 0.2 notebook".into())
            .unwrap();
        let created = engine.create_note().unwrap();
        let before = engine
            .update_note(
                created.notes[0].id.clone(),
                "Keep me".into(),
                "Existing text".into(),
                created.heads,
            )
            .unwrap();
        drop(engine);
        // Revert only the new migration to reproduce the shipped 0.2 schema.
        let database = directory.path().join(crate::storage::DATABASE_NAME);
        let mut connection =
            diesel::sqlite::SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        const MIGRATIONS: diesel_migrations::EmbeddedMigrations =
            diesel_migrations::embed_migrations!("migrations");
        connection.revert_last_migration(MIGRATIONS).unwrap();
        drop(connection);
        let upgraded = Engine::open(directory.path().into()).unwrap();
        let after = upgraded.snapshot().unwrap();
        assert_eq!(after.device_id, before.device_id);
        assert_eq!(after.heads, before.heads);
        assert_eq!(after.notes[0].body, "Existing text");
        assert_eq!(
            after.network.unwrap().invite,
            before.network.unwrap().invite
        );
        assert_eq!(upgraded.get_settings().unwrap().theme, Theme::System);
        assert!(
            upgraded
                .import_file_bytes(
                    active_network_id(&upgraded),
                    "new.txt".into(),
                    "text/plain".into(),
                    b"works".to_vec()
                )
                .unwrap()
                .files[0]
                .available
        );
    }

    #[test]
    fn file_commands_reject_a_stale_network_instead_of_sharing_into_a_new_one() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        let first = engine
            .create_network("Private A".into())
            .unwrap()
            .network
            .unwrap();
        let imported = engine
            .import_file_bytes(
                first.id.clone(),
                "private.txt".into(),
                "text/plain".into(),
                b"only A".to_vec(),
            )
            .unwrap();
        let id = imported.files[0].id.clone();
        engine.create_network("Different B".into()).unwrap();
        assert!(engine
            .import_file_bytes(
                first.id.clone(),
                "selected-in-A.txt".into(),
                "text/plain".into(),
                b"must not leak".to_vec()
            )
            .is_err());
        assert!(engine
            .read_file_bytes(first.id.clone(), id.clone())
            .is_err());
        assert!(engine.delete_file(first.id.clone(), id.clone()).is_err());
        assert!(engine.snapshot().unwrap().files.is_empty());
        engine.join_network(first.invite).unwrap();
        assert_eq!(engine.snapshot().unwrap().files.len(), 1);
        assert_eq!(engine.read_file_bytes(first.id, id).unwrap().2, b"only A");
    }

    #[test]
    fn noncanonical_file_ids_and_directory_names_are_rejected() {
        let (_da, _db, a, b) = pair();
        let network_id = active_network_id(&a);
        for name in [".", ".."] {
            assert!(a
                .import_file_bytes(network_id.clone(), name.into(), "text/plain".into(), vec![])
                .is_err());
        }
        let packet = a.packet().unwrap().unwrap();
        let mut doc = AutoCommit::load(&packet.document).unwrap();
        files::add_file(
            &mut doc,
            &FileRecord {
                id: "F4F16310-31D0-48B9-AB66-EAD758F68F73".into(),
                name: "invalid.txt".into(),
                mime_type: "text/plain".into(),
                size: 0,
                sha256: files::content_hash(&[]),
                created_at: now(),
                deleted: false,
                tags: vec![],
            },
        )
        .unwrap();
        assert!(b.accept_document(&network_id, &doc.save()).is_err());
        assert!(b.snapshot().unwrap().files.is_empty());
    }

    #[test]
    fn failed_blob_insert_rolls_back_its_file_metadata_in_sqlite() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path().into()).unwrap();
        engine.create_network("Atomic files".into()).unwrap();
        let mut state = engine.state().unwrap();
        let network = state.network.clone().unwrap();
        let mut doc = state.doc.clone().unwrap();
        let hash = files::content_hash(b"data");
        files::add_file(
            &mut doc,
            &FileRecord {
                id: Uuid::new_v4().to_string(),
                name: "atomic.txt".into(),
                mime_type: "text/plain".into(),
                size: 4,
                sha256: hash.clone(),
                created_at: now(),
                deleted: false,
                tags: vec![],
            },
        )
        .unwrap();
        let record = encode_saved_network(&network, doc.save()).unwrap();
        let invalid_blob = StoredBlob {
            network_id: network.id.clone(),
            sha256: hash.clone(),
            size_bytes: 5,
            content: b"data".to_vec(),
        };
        assert!(state
            .store
            .save_network(&record, false, None, Some(&invalid_blob), &[hash])
            .is_err());
        let saved = state.store.network(&network.id).unwrap().unwrap();
        assert!(
            files::read_files(&AutoCommit::load(&saved.document).unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(state.store.blob_catalog(&network.id).unwrap().is_empty());
    }

    #[test]
    fn peer_addresses_are_numeric_unicast() {
        for address in [
            "192.168.1.7",
            "10.0.0.4",
            "127.0.0.1",
            "::1",
            "fe80::1234%7",
            "fd00::abcd",
            "2001:db8::1234",
            "100.64.1.7",
        ] {
            assert!(valid_peer_address(address), "{address}");
        }
        for address in [
            "example.com",
            "https://127.0.0.1",
            "127.0.0.1%7",
            "fe80::1%en0",
            "fe80::1%0",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::",
            "ff02::fb",
        ] {
            assert!(!valid_peer_address(address), "{address}");
        }
    }
}
