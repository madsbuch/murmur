//! Durable, local-first notes. The UI never owns the authoritative document.
use crate::storage::{DraftClear, Store, StoredDraft, StoredNetwork, StoredState};
use automerge::{
    transaction::Transactable, ActorId, AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc, Value,
    ROOT,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    pub heads: Vec<String>,
    pub status: SyncStatus,
    pub device_id: String,
    pub listener_port: u16,
}
#[derive(Clone, Serialize)]
pub struct NetworkView {
    pub id: String,
    pub name: String,
    pub invite: String,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub updated_at: u64,
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
        let (notes, heads) = if let Some(doc) = &mut s.doc {
            (
                read_notes(doc)?,
                doc.get_heads().iter().map(ToString::to_string).collect(),
            )
        } else {
            (vec![], vec![])
        };
        let network = match &s.network {
            Some(network) => Some(NetworkView {
                id: network.id.clone(),
                name: network.name.clone(),
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
        let network = Network {
            v: 1,
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            secret: URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
        };
        let doc = genesis(&network.id)?;
        self.activate(network, doc)
    }

    pub fn join_network(&self, invite: String) -> Result<Snapshot> {
        let network = parse_invite(&invite)?;
        // Hold the same lock as edits/sync while restoring an archive, including
        // when rejoining the active network, so a merge cannot be overwritten.
        let mut state = self.state()?;
        let doc = if let Some(saved) = state.store.network(&network.id)? {
            let (old, doc) = decode_saved_network(saved)?;
            if old.secret != network.secret {
                return Err("This invitation has a different secret for a saved network.".into());
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
        self.snapshot_locked(s)
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
    for id in doc.keys(ROOT).filter(|id| !id.starts_with('_')) {
        validate_id(&id)?;
        let object = note_object(doc, &id)?;
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
    let bytes = doc.save();
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("This network has reached the 8 MB MVP limit.".into());
    }
    store.save_network(
        &encode_saved_network(network, bytes.clone())?,
        activate,
        draft_clear,
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
