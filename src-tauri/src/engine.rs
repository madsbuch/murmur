//! Durable, local-first notes. The UI never owns the authoritative document.
use automerge::{
    transaction::Transactable, ActorId, AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc, Value,
    ROOT,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
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
    device_id: String,
    network: Option<Network>,
    doc: Option<AutoCommit>,
    peers: HashMap<String, PeerState>,
    last_sync: Option<u64>,
    error: Option<String>,
}
pub struct Engine {
    directory: PathBuf,
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
        fs::create_dir_all(&directory).map_err(err)?;
        let config_path = directory.join("state.json");
        let config: Config = if config_path.exists() {
            let c: Config =
                serde_json::from_slice(&fs::read(&config_path).map_err(err)?).map_err(err)?;
            if c.v != 1 || Uuid::parse_str(&c.device_id).is_err() {
                return Err("This local store is not supported.".into());
            }
            c
        } else {
            let c = Config {
                v: 1,
                device_id: Uuid::new_v4().to_string(),
                active_network: None,
            };
            write_json(&config_path, &c)?;
            c
        };
        let (network, doc) = if let Some(id) = &config.active_network {
            validate_id(id)?;
            let (network, doc) = read_network(&directory, id)?;
            (Some(network), Some(doc))
        } else {
            (None, None)
        };
        Ok(Arc::new(Self {
            directory,
            state: Mutex::new(State {
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
        let network = s.network.as_ref().map(|n| NetworkView {
            id: n.id.clone(),
            name: n.name.clone(),
            invite: format!(
                "{INVITE_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(n).expect("serializable network"))
            ),
        });
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
        let path = network_path(&self.directory, &network.id);
        let doc = if path.exists() {
            let (old, doc) = read_network(&self.directory, &network.id)?;
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
        save_network(&self.directory, &network, &mut doc)?;
        write_json(
            &self.directory.join("state.json"),
            &Config {
                v: 1,
                device_id: s.device_id.clone(),
                active_network: Some(network.id.clone()),
            },
        )?;
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
        self.edit(|doc| {
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
        self.edit(|doc| {
            let object = note_object(doc, &id)?;
            // Never remove the map: a concurrent edit cannot resurrect a deleted note.
            doc.put(&object, "deleted", true).map_err(err)?;
            doc.put(&object, "updatedAt", now()).map_err(err)?;
            Ok(())
        })
    }

    fn edit(&self, update: impl FnOnce(&mut AutoCommit) -> Result<()>) -> Result<Snapshot> {
        let mut s = self.state()?;
        let network = s.network.clone().ok_or("Create or join a network first.")?;
        let mut doc = s
            .doc
            .as_ref()
            .ok_or("The local document is missing.")?
            .clone();
        update(&mut doc)?;
        validate_document(&doc, &network.id)?;
        save_network(&self.directory, &network, &mut doc)?;
        s.doc = Some(doc);
        self.sync_requested.notify_one();
        self.snapshot_locked(&mut s)
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
            let bytes = save_network(&self.directory, &network, &mut doc)?;
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
fn read_network(directory: &Path, id: &str) -> Result<(Network, AutoCommit)> {
    let bytes = fs::read(network_path(directory, id)).map_err(err)?;
    if bytes.len() > MAX_DOCUMENT_BYTES * 2 {
        return Err("Saved network exceeds the MVP size limit.".into());
    }
    let disk: NetworkDisk = serde_json::from_slice(&bytes).map_err(err)?;
    validate_network(&disk.network)?;
    if disk.network.id != id {
        return Err("Saved network ID does not match.".into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(&disk.document).map_err(err)?;
    let mut doc = AutoCommit::load(&bytes).map_err(err)?;
    validate_document(&doc, id)?;
    doc.set_actor(ActorId::from(Uuid::new_v4().as_bytes().as_slice()));
    Ok((disk.network, doc))
}
fn save_network(directory: &Path, network: &Network, doc: &mut AutoCommit) -> Result<Vec<u8>> {
    let bytes = doc.save();
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("This network has reached the 8 MB MVP limit.".into());
    }
    write_json(
        &network_path(directory, &network.id),
        &NetworkDisk {
            network: network.clone(),
            document: URL_SAFE_NO_PAD.encode(&bytes),
        },
    )?;
    Ok(bytes)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(err)?;
        file.write_all(&serde_json::to_vec(value).map_err(err)?)
            .map_err(err)?;
        file.sync_all().map_err(err)?;
        fs::rename(&temp, path).map_err(err)?;
        #[cfg(unix)]
        {
            File::open(path.parent().ok_or("Missing data directory")?)
                .map_err(err)?
                .sync_all()
                .map_err(err)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
