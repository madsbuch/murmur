//! Encrypted note snapshots and bounded file transfers, directly between peers.
use crate::engine::{
    Engine, MissingFile, Packet, Peer, SyncIdentity, MAX_DOCUMENT_BYTES, MAX_FILE_BYTES,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::{interval, timeout, MissedTickBehavior},
};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"MURMUR01";
const HEADER_BYTES: usize = 8 + 16 + 1 + 24;
const MAX_FRAME: usize = MAX_FILE_BYTES + HEADER_BYTES + 16;
const MAX_FILE_REQUEST_BYTES: usize = 512;
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(8);
const FILE_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST: u8 = 1;
const RESPONSE: u8 = 2;
const FILE_REQUEST: u8 = 3;
const FILE_RESPONSE: u8 = 4;
type Result<T> = std::result::Result<T, String>;

pub async fn start(engine: Arc<Engine>) -> Result<()> {
    let listener = bind_listener()?;
    engine.set_port(listener.local_addr().map_err(err)?.port());
    spawn_listener(engine.clone(), listener);
    spawn_file_retry(engine.clone());
    tokio::spawn(async move {
        let mut retry = interval(Duration::from_secs(5));
        retry.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = retry.tick() => {}, _ = engine.sync_requested.notified() => {} }
            let mut jobs = JoinSet::new();
            for peer in engine.peers() {
                if jobs.len() >= 8 {
                    let _ = jobs.join_next().await;
                }
                let engine = engine.clone();
                jobs.spawn(async move {
                    let result = timeout(EXCHANGE_TIMEOUT, exchange(&engine, &peer))
                        .await
                        .map_err(|_| "Peer timed out.".to_string())
                        .and_then(|r| r);
                    engine.sync_result(&peer, result);
                });
            }
            while jobs.join_next().await.is_some() {}
        }
    });
    Ok(())
}

fn spawn_file_retry(engine: Arc<Engine>) {
    tokio::spawn(async move {
        let mut retry = interval(Duration::from_secs(5));
        retry.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_file = 0;
        let mut next_peer = 0;
        let slots = Arc::new(Semaphore::new(2));
        loop {
            tokio::select! { _ = retry.tick() => {}, _ = engine.files_requested.notified() => {} }
            let Ok(Some(identity)) = engine.sync_identity() else {
                continue;
            };
            let Ok(missing) = engine.missing_files(&identity.network_id) else {
                continue;
            };
            let mut peers: Vec<_> = engine
                .peers()
                .into_iter()
                .filter(|peer| peer.network_id == identity.network_id)
                .collect();
            if missing.is_empty() || peers.is_empty() {
                continue;
            }
            // Rotate both lists so an unavailable file or old peer cannot starve
            // other downloads. File failures never change note-sync status.
            let peer_count = peers.len();
            peers.rotate_left(next_peer % peer_count);
            next_peer = (next_peer % peer_count + 1) % peer_count;
            let first = next_file % missing.len();
            let count = missing.len().min(2);
            let mut jobs = JoinSet::new();
            for offset in 0..count {
                let file = missing[(first + offset) % missing.len()].clone();
                let identity = SyncIdentity {
                    network_id: identity.network_id.clone(),
                    secret: identity.secret,
                };
                let engine = engine.clone();
                let peers = peers.clone();
                let slots = slots.clone();
                jobs.spawn(async move {
                    let _ = timeout(
                        FILE_EXCHANGE_TIMEOUT,
                        fetch_file(engine, identity, file, peers, slots),
                    )
                    .await;
                });
            }
            next_file = (first + count) % missing.len();
            while jobs.join_next().await.is_some() {}
        }
    });
}

fn spawn_listener(engine: Arc<Engine>, listener: TcpListener) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let headers = Arc::new(Semaphore::new(16));
        let note_slots = Arc::new(Semaphore::new(8));
        let file_slots = Arc::new(Semaphore::new(2));
        loop {
            let Ok((socket, _address)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            let Ok(permit) = headers.clone().try_acquire_owned() else {
                drop(socket);
                continue;
            };
            let engine = engine.clone();
            let note_slots = note_slots.clone();
            let file_slots = file_slots.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = serve(engine, socket, note_slots, file_slots).await;
            });
        }
    })
}

fn bind_listener() -> Result<TcpListener> {
    // Apple and Android both support a dual-stack socket. Keep an IPv4 fallback
    // for hosts where IPv6 is disabled, using the same ephemeral advertised port.
    let socket = (|| -> std::io::Result<Socket> {
        let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_only_v6(false)?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
        Ok(socket)
    })()
    .or_else(|_| -> std::io::Result<Socket> {
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
        Ok(socket)
    })
    .map_err(err)?;
    socket.listen(16).map_err(err)?;
    socket.set_nonblocking(true).map_err(err)?;
    TcpListener::from_std(socket.into()).map_err(err)
}

async fn serve(
    engine: Arc<Engine>,
    mut socket: TcpStream,
    note_slots: Arc<Semaphore>,
    file_slots: Arc<Semaphore>,
) -> Result<()> {
    // Read and validate the small header before allocating a payload or taking
    // a role-specific slot. Large file responses are never accepted by a server.
    let header = timeout(
        EXCHANGE_TIMEOUT,
        read_header(&mut socket, &[REQUEST, FILE_REQUEST]),
    )
    .await
    .map_err(|_| "Peer header timed out.".to_string())??;
    let is_file = header.bytes[24] == FILE_REQUEST;
    let slots = if is_file { file_slots } else { note_slots };
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| "Peer transfer slots are busy.".to_string())?;
    let duration = if is_file {
        FILE_EXCHANGE_TIMEOUT
    } else {
        EXCHANGE_TIMEOUT
    };
    timeout(duration, async move {
        let permit = Arc::new(permit);
        let frame = read_body(&mut socket, header).await?;
        let identity = engine.sync_identity()?.ok_or("No active network")?;
        let role = if is_file { FILE_REQUEST } else { REQUEST };
        let incoming = decrypt(&frame, &identity.network_id, &identity.secret, role)?;
        let response = if is_file {
            let request: MissingFile = serde_json::from_slice(&incoming).map_err(err)?;
            // Share the permit with the blocking job: even if the socket times
            // out, an outstanding disk/hash job still occupies its file slot.
            let work_permit = permit.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = work_permit;
                let bytes = engine.read_file_for_sync(&identity.network_id, &request)?;
                encrypt_payload(
                    &identity.network_id,
                    &identity.secret,
                    &bytes,
                    FILE_RESPONSE,
                )
            })
            .await
            .map_err(err)??
        } else {
            let document = engine.accept_document(&identity.network_id, &incoming)?;
            encrypt_payload(&identity.network_id, &identity.secret, &document, RESPONSE)?
        };
        let result = write_frame(&mut socket, &response).await;
        drop(permit);
        result
    })
    .await
    .map_err(|_| "Peer transfer timed out.".to_string())?
}

pub(crate) async fn exchange(engine: &Engine, peer: &Peer) -> Result<()> {
    let packet = engine.packet()?.ok_or("No active network")?;
    if packet.network_id != peer.network_id {
        return Err("The active network changed.".into());
    }
    let request = encrypt(&packet, REQUEST)?;
    let mut last_error = "Peer has no usable address.".to_string();
    for address in &peer.addresses {
        let address = if address.contains(':') {
            format!("[{address}]:{}", peer.port)
        } else {
            format!("{address}:{}", peer.port)
        };
        // Native discovery normalizes IPv6 zones to numeric indices. Parse
        // directly so peer connections never depend on DNS resolution.
        let address = match address.parse::<SocketAddr>() {
            Ok(address) => address,
            Err(_) => {
                last_error = "Invalid numeric peer address.".into();
                continue;
            }
        };
        let connection = timeout(Duration::from_secs(2), TcpStream::connect(address)).await;
        let mut socket = match connection {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                last_error = e.to_string();
                continue;
            }
            Err(_) => {
                last_error = "Peer connection timed out.".into();
                continue;
            }
        };
        socket.set_nodelay(true).map_err(err)?;
        write_frame(&mut socket, &request).await?;
        let frame = read_frame(&mut socket, RESPONSE).await?;
        let document = decrypt(&frame, &packet.network_id, &packet.secret, RESPONSE)?;
        engine.accept_document(&packet.network_id, &document)?;
        return Ok(());
    }
    Err(last_error)
}

async fn fetch_file(
    engine: Arc<Engine>,
    identity: SyncIdentity,
    file: MissingFile,
    peers: Vec<Peer>,
    slots: Arc<Semaphore>,
) -> Result<()> {
    let permit = Arc::new(slots.acquire_owned().await.map_err(err)?);
    let request = serde_json::to_vec(&file).map_err(err)?;
    let request = encrypt_payload(
        &identity.network_id,
        &identity.secret,
        &request,
        FILE_REQUEST,
    )?;
    let mut last_error = "No peer has this file yet.".to_string();
    for peer in peers {
        for address in peer.addresses {
            let address = if address.contains(':') {
                format!("[{address}]:{}", peer.port)
            } else {
                format!("{address}:{}", peer.port)
            };
            let Ok(address) = address.parse::<SocketAddr>() else {
                continue;
            };
            let connection = timeout(Duration::from_secs(2), TcpStream::connect(address)).await;
            let Ok(Ok(mut socket)) = connection else {
                continue;
            };
            let response = async {
                socket.set_nodelay(true).map_err(err)?;
                write_frame(&mut socket, &request).await?;
                read_frame(&mut socket, FILE_RESPONSE).await
            }
            .await;
            match response {
                Ok(frame) => {
                    let engine = engine.clone();
                    let network_id = identity.network_id.clone();
                    let secret = identity.secret;
                    let file = file.clone();
                    let work_permit = permit.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let _permit = work_permit;
                        let bytes = decrypt(&frame, &network_id, &secret, FILE_RESPONSE)?;
                        engine.accept_file(&network_id, &file, &bytes)
                    })
                    .await
                    .map_err(err)?;
                    match result {
                        Ok(()) => return Ok(()),
                        Err(error) => last_error = error,
                    }
                }
                Err(error) => last_error = error,
            }
        }
    }
    Err(last_error)
}

fn encrypt(packet: &Packet, role: u8) -> Result<Vec<u8>> {
    encrypt_payload(&packet.network_id, &packet.secret, &packet.document, role)
}
fn payload_limit(role: u8) -> Result<usize> {
    match role {
        REQUEST | RESPONSE => Ok(MAX_DOCUMENT_BYTES),
        FILE_REQUEST => Ok(MAX_FILE_REQUEST_BYTES),
        FILE_RESPONSE => Ok(MAX_FILE_BYTES),
        _ => Err("Unknown sync frame role.".into()),
    }
}
fn encrypt_payload(network_id: &str, secret: &[u8; 32], bytes: &[u8], role: u8) -> Result<Vec<u8>> {
    if bytes.len() > payload_limit(role)? {
        return Err("Sync payload exceeds the size limit.".into());
    }
    let network = Uuid::parse_str(network_id).map_err(err)?;
    let nonce: [u8; 24] = rand::random();
    let mut frame = Vec::with_capacity(bytes.len() + HEADER_BYTES + 16);
    frame.extend_from_slice(MAGIC);
    frame.extend_from_slice(network.as_bytes());
    frame.push(role);
    let cipher = XChaCha20Poly1305::new_from_slice(secret).map_err(err)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: bytes,
                aad: &frame,
            },
        )
        .map_err(|_| "Could not encrypt the document.".to_string())?;
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&ciphertext);
    if frame.len() > MAX_FRAME {
        return Err("Sync frame exceeds the size limit.".into());
    }
    Ok(frame)
}
fn decrypt(frame: &[u8], network_id: &str, secret: &[u8; 32], role: u8) -> Result<Vec<u8>> {
    if frame.len() < HEADER_BYTES + 16
        || frame.len() > payload_limit(role)? + HEADER_BYTES + 16
        || &frame[..8] != MAGIC
        || frame[24] != role
    {
        return Err("Invalid sync frame.".into());
    }
    let network = Uuid::parse_str(network_id).map_err(err)?;
    if &frame[8..24] != network.as_bytes() {
        return Err("The peer belongs to another network.".into());
    }
    let nonce: [u8; 24] = frame[25..HEADER_BYTES].try_into().map_err(err)?;
    let cipher = XChaCha20Poly1305::new_from_slice(secret).map_err(err)?;
    cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &frame[HEADER_BYTES..],
                aad: &frame[..25],
            },
        )
        .map_err(|_| "The peer could not authenticate with this network.".into())
}
struct FrameHeader {
    bytes: [u8; HEADER_BYTES],
    length: usize,
}
async fn read_header(socket: &mut TcpStream, allowed_roles: &[u8]) -> Result<FrameHeader> {
    let length = usize::try_from(socket.read_u32().await.map_err(err)?).map_err(err)?;
    if !(HEADER_BYTES + 16..=MAX_FRAME).contains(&length) {
        return Err("Invalid sync frame size.".into());
    }
    let mut bytes = [0; HEADER_BYTES];
    socket.read_exact(&mut bytes).await.map_err(err)?;
    if &bytes[..8] != MAGIC
        || !allowed_roles.contains(&bytes[24])
        || length > payload_limit(bytes[24])? + HEADER_BYTES + 16
    {
        return Err("Invalid sync frame header.".into());
    }
    Ok(FrameHeader { bytes, length })
}
async fn read_body(socket: &mut TcpStream, header: FrameHeader) -> Result<Vec<u8>> {
    let mut frame = vec![0; header.length];
    frame[..HEADER_BYTES].copy_from_slice(&header.bytes);
    socket
        .read_exact(&mut frame[HEADER_BYTES..])
        .await
        .map_err(err)?;
    Ok(frame)
}
async fn read_frame(socket: &mut TcpStream, role: u8) -> Result<Vec<u8>> {
    let header = read_header(socket, &[role]).await?;
    read_body(socket, header).await
}
async fn write_frame(socket: &mut TcpStream, frame: &[u8]) -> Result<()> {
    if frame.len() < HEADER_BYTES + 16
        || frame.len() > payload_limit(frame[24])? + HEADER_BYTES + 16
    {
        return Err("Sync frame exceeds the size limit.".into());
    }
    let length = u32::try_from(frame.len()).map_err(err)?;
    socket.write_u32(length).await.map_err(err)?;
    socket.write_all(frame).await.map_err(err)?;
    socket.flush().await.map_err(err)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer_for(engine: &Engine, port: u16) -> Peer {
        let snapshot = engine.snapshot().unwrap();
        Peer {
            device_id: snapshot.device_id,
            network_id: snapshot.network.unwrap().id,
            addresses: vec!["127.0.0.1".into()],
            port,
        }
    }

    #[test]
    fn file_frames_authenticate_their_role_and_reject_oversized_requests() {
        let network = Uuid::new_v4().to_string();
        let secret = [7; 32];
        let request = encrypt_payload(&network, &secret, b"file metadata", FILE_REQUEST).unwrap();
        assert_eq!(
            decrypt(&request, &network, &secret, FILE_REQUEST).unwrap(),
            b"file metadata"
        );
        assert!(decrypt(&request, &network, &secret, REQUEST).is_err());
        assert!(decrypt(&request, &network, &secret, FILE_RESPONSE).is_err());
        assert!(decrypt(&request, &network, &[8; 32], FILE_REQUEST).is_err());
        let response = encrypt_payload(&network, &secret, b"file content", FILE_RESPONSE).unwrap();
        assert!(decrypt(&response, &network, &secret, RESPONSE).is_err());
        let mut forged = response;
        forged[24] = RESPONSE;
        assert!(decrypt(&forged, &network, &secret, RESPONSE).is_err());
        assert!(encrypt_payload(
            &network,
            &secret,
            &[0; MAX_FILE_REQUEST_BYTES + 1],
            FILE_REQUEST
        )
        .is_err());
        assert!(encrypt_payload(&network, &secret, b"", 255).is_err());
    }

    #[tokio::test]
    async fn invalid_headers_are_rejected_before_reading_or_allocating_large_bodies() {
        for (role, length, allowed) in [
            (
                FILE_REQUEST,
                MAX_FILE_REQUEST_BYTES + HEADER_BYTES + 17,
                FILE_REQUEST,
            ),
            (REQUEST, MAX_DOCUMENT_BYTES + HEADER_BYTES + 17, REQUEST),
            (FILE_RESPONSE, MAX_FRAME + 1, FILE_RESPONSE),
            (FILE_RESPONSE, HEADER_BYTES + 16, REQUEST),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (mut server, _) = listener.accept().await.unwrap();
            let mut header = [0; HEADER_BYTES];
            header[..8].copy_from_slice(MAGIC);
            header[24] = role;
            client
                .write_u32(u32::try_from(length).unwrap())
                .await
                .unwrap();
            client.write_all(&header).await.unwrap();
            // The sender deliberately keeps the socket open without a body.
            assert!(
                timeout(Duration::from_secs(1), read_frame(&mut server, allowed))
                    .await
                    .unwrap()
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn file_larger_than_note_limit_transfers_and_survives_reopen() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Files".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        let bytes = vec![42; MAX_DOCUMENT_BYTES + 1];
        a.import_file_bytes(
            a.sync_identity().unwrap().unwrap().network_id,
            "large.bin".into(),
            "application/octet-stream".into(),
            bytes.clone(),
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let peer = peer_for(&a, listener.local_addr().unwrap().port());
        let server = spawn_listener(a.clone(), listener);
        exchange(&b, &peer).await.unwrap();
        let identity = b.sync_identity().unwrap().unwrap();
        let network = identity.network_id.clone();
        let file = b.missing_files(&network).unwrap().remove(0);
        let mut wrong_file = file.clone();
        wrong_file.sha256 = "0".repeat(64);
        assert!(fetch_file(
            b.clone(),
            b.sync_identity().unwrap().unwrap(),
            wrong_file,
            vec![peer.clone()],
            Arc::new(Semaphore::new(2))
        )
        .await
        .is_err());
        assert_eq!(b.missing_files(&network).unwrap().len(), 1);
        fetch_file(
            b.clone(),
            identity,
            file.clone(),
            vec![peer],
            Arc::new(Semaphore::new(2)),
        )
        .await
        .unwrap();
        assert!(b.missing_files(&network).unwrap().is_empty());
        assert_eq!(b.read_file_for_sync(&network, &file).unwrap(), bytes);
        drop(b);
        let reopened = Engine::open(db.path().into()).unwrap();
        assert_eq!(reopened.read_file_for_sync(&network, &file).unwrap(), bytes);
        server.abort();
    }

    #[tokio::test]
    async fn occupied_file_slots_do_not_block_notes_or_allow_a_third_file_transfer() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Files".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        a.import_file_bytes(
            a.sync_identity().unwrap().unwrap().network_id,
            "test.txt".into(),
            "text/plain".into(),
            b"nearby file".to_vec(),
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = peer_for(&a, address.port());
        let server = spawn_listener(a.clone(), listener);
        exchange(&b, &peer).await.unwrap();
        let identity = b.sync_identity().unwrap().unwrap();
        let file = b.missing_files(&identity.network_id).unwrap().remove(0);
        let frame = encrypt_payload(
            &identity.network_id,
            &identity.secret,
            &serde_json::to_vec(&file).unwrap(),
            FILE_REQUEST,
        )
        .unwrap();
        let mut held = Vec::new();
        for _ in 0..2 {
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket
                .write_u32(u32::try_from(frame.len()).unwrap())
                .await
                .unwrap();
            socket.write_all(&frame[..HEADER_BYTES]).await.unwrap();
            held.push(socket);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let note = b.create_note().unwrap();
        b.update_note(
            note.notes[0].id.clone(),
            "Still responsive".into(),
            "notes keep syncing".into(),
            note.heads,
        )
        .unwrap();
        timeout(Duration::from_secs(2), exchange(&b, &peer))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(a.snapshot().unwrap().notes[0].body, "notes keep syncing");
        assert!(timeout(
            Duration::from_secs(2),
            fetch_file(
                b.clone(),
                identity,
                file.clone(),
                vec![peer.clone()],
                Arc::new(Semaphore::new(2))
            )
        )
        .await
        .unwrap()
        .is_err());
        drop(held);
        tokio::time::sleep(Duration::from_millis(50)).await;
        fetch_file(
            b.clone(),
            b.sync_identity().unwrap().unwrap(),
            file,
            vec![peer],
            Arc::new(Semaphore::new(2)),
        )
        .await
        .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn older_note_only_peer_still_syncs_after_rejecting_file_request() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Mixed versions".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        a.import_file_bytes(
            a.sync_identity().unwrap().unwrap().network_id,
            "test.txt".into(),
            "text/plain".into(),
            b"file".to_vec(),
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let peer = peer_for(&a, listener.local_addr().unwrap().port());
        let older = a.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let engine = older.clone();
                tokio::spawn(async move {
                    let Ok(frame) = read_frame(&mut socket, REQUEST).await else {
                        return;
                    };
                    let packet = engine.packet().unwrap().unwrap();
                    let incoming =
                        decrypt(&frame, &packet.network_id, &packet.secret, REQUEST).unwrap();
                    let document = engine
                        .accept_document(&packet.network_id, &incoming)
                        .unwrap();
                    let response = encrypt(&Packet { document, ..packet }, RESPONSE).unwrap();
                    let _ = write_frame(&mut socket, &response).await;
                });
            }
        });
        exchange(&b, &peer).await.unwrap();
        let identity = b.sync_identity().unwrap().unwrap();
        let file = b.missing_files(&identity.network_id).unwrap().remove(0);
        assert!(fetch_file(
            b.clone(),
            identity,
            file,
            vec![peer.clone()],
            Arc::new(Semaphore::new(2))
        )
        .await
        .is_err());
        let note = b.create_note().unwrap();
        b.update_note(
            note.notes[0].id.clone(),
            "Compatible".into(),
            "works with older peers".into(),
            note.heads,
        )
        .unwrap();
        exchange(&b, &peer).await.unwrap();
        assert_eq!(
            a.snapshot().unwrap().notes[0].body,
            "works with older peers"
        );
        assert!(b.snapshot().unwrap().status.error.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn background_file_retry_completes_after_peer_reconnects() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Files".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        a.import_file_bytes(
            a.sync_identity().unwrap().unwrap().network_id,
            "offline.txt".into(),
            "text/plain".into(),
            b"arrives on reconnect".to_vec(),
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = peer_for(&a, address.port());
        let server = spawn_listener(a.clone(), listener);
        exchange(&b, &peer).await.unwrap();
        let network = peer.network_id.clone();
        let file = b.missing_files(&network).unwrap().remove(0);
        server.abort();
        let _ = server.await;
        start(b.clone()).await.unwrap();
        b.peer_discovered(peer).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(b.missing_files(&network).unwrap().len(), 1);
        let server = spawn_listener(a.clone(), TcpListener::bind(address).await.unwrap());
        // No manual sync, discovery event, or edit follows this reconnect.
        timeout(Duration::from_secs(7), async {
            while !b.missing_files(&network).unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            b.read_file_for_sync(&network, &file).unwrap(),
            b"arrives on reconnect"
        );
        server.abort();
    }

    #[test]
    fn encryption_authenticates_secret_network_and_direction() {
        let packet = Packet {
            network_id: Uuid::new_v4().to_string(),
            secret: [5; 32],
            document: b"private note".to_vec(),
        };
        let frame = encrypt(&packet, REQUEST).unwrap();
        assert!(!frame.windows(12).any(|w| w == b"private note"));
        assert_eq!(
            decrypt(&frame, &packet.network_id, &packet.secret, REQUEST).unwrap(),
            packet.document
        );
        assert!(decrypt(&frame, &packet.network_id, &[6; 32], REQUEST).is_err());
        assert!(decrypt(&frame, &Uuid::new_v4().to_string(), &packet.secret, REQUEST).is_err());
        assert!(decrypt(&frame, &packet.network_id, &packet.secret, RESPONSE).is_err());
        let mut tampered = frame.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt(&tampered, &packet.network_id, &packet.secret, REQUEST).is_err());
        assert!(decrypt(&[0; 5], &packet.network_id, &packet.secret, REQUEST).is_err());
    }
    #[tokio::test]
    async fn real_tcp_exchange_converges_after_peer_reconnects() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        let invite = a
            .create_network("Desk".into())
            .unwrap()
            .network
            .unwrap()
            .invite;
        b.join_network(invite).unwrap();
        start(a.clone()).await.unwrap();
        start(b.clone()).await.unwrap();
        let snapshot = b.snapshot().unwrap();
        let mut peer = Peer {
            device_id: snapshot.device_id,
            network_id: snapshot.network.unwrap().id,
            addresses: vec!["127.0.0.1".into()],
            port: snapshot.listener_port,
        };
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        a.update_note(id.clone(), "Plan".into(), "walk".into(), first.heads)
            .unwrap();
        exchange(&a, &peer).await.unwrap();
        assert_eq!(b.snapshot().unwrap().notes[0].body, "walk");
        let original_port = peer.port;
        peer.port = 1;
        assert!(exchange(&a, &peer).await.is_err());
        let sa = a.snapshot().unwrap();
        let sb = b.snapshot().unwrap();
        a.update_note(id.clone(), "Plan".into(), "long walk".into(), sa.heads)
            .unwrap();
        b.update_note(id, "Plan".into(), "walk outside".into(), sb.heads)
            .unwrap();
        peer.port = original_port;
        exchange(&a, &peer).await.unwrap();
        assert_eq!(a.snapshot().unwrap().notes[0].body, "long walk outside");
        assert_eq!(b.snapshot().unwrap().notes[0].body, "long walk outside");
    }
    #[tokio::test]
    async fn auto_retry_syncs_a_discovered_peer() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Desk".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        start(a.clone()).await.unwrap();
        start(b.clone()).await.unwrap();
        let first = a.create_note().unwrap();
        a.update_note(
            first.notes[0].id.clone(),
            "Hi".into(),
            "nearby".into(),
            first.heads,
        )
        .unwrap();
        let bs = b.snapshot().unwrap();
        a.peer_discovered(Peer {
            device_id: bs.device_id,
            network_id: bs.network.unwrap().id,
            addresses: vec!["127.0.0.1".into()],
            port: bs.listener_port,
        })
        .unwrap();
        timeout(Duration::from_secs(4), async {
            loop {
                if b.snapshot()
                    .unwrap()
                    .notes
                    .first()
                    .is_some_and(|n| n.body == "nearby")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn periodic_retry_reconnects_without_new_discovery_or_manual_sync() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = Engine::open(da.path().into()).unwrap();
        let b = Engine::open(db.path().into()).unwrap();
        b.join_network(
            a.create_network("Desk".into())
                .unwrap()
                .network
                .unwrap()
                .invite,
        )
        .unwrap();
        start(a.clone()).await.unwrap();
        // Use the production server handler with a controllable listener to model
        // the peer disappearing from Wi-Fi while its endpoint remains cached.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = spawn_listener(b.clone(), listener);
        let first = a.create_note().unwrap();
        let id = first.notes[0].id.clone();
        a.update_note(id.clone(), "Plan".into(), "walk".into(), first.heads)
            .unwrap();
        let bs = b.snapshot().unwrap();
        a.peer_discovered(Peer {
            device_id: bs.device_id,
            network_id: bs.network.unwrap().id,
            addresses: vec!["127.0.0.1".into()],
            port: address.port(),
        })
        .unwrap();
        timeout(Duration::from_secs(4), async {
            loop {
                if b.snapshot()
                    .unwrap()
                    .notes
                    .first()
                    .is_some_and(|n| n.body == "walk")
                    && a.snapshot().unwrap().status.last_sync.is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        server.abort();
        let _ = server.await;
        let sa = a.snapshot().unwrap();
        let sb = b.snapshot().unwrap();
        a.update_note(id.clone(), "Plan".into(), "long walk".into(), sa.heads)
            .unwrap();
        b.update_note(id, "Plan".into(), "walk outside".into(), sb.heads)
            .unwrap();
        // Let the mutation-triggered attempts fail while the peer is absent.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(b.snapshot().unwrap().notes[0].body, "walk outside");
        let listener = TcpListener::bind(address).await.unwrap();
        let server = spawn_listener(b.clone(), listener);
        // No peer_discovered, request_sync, exchange, or new edit after reconnect:
        // only the real five-second retry timer can complete this synchronization.
        timeout(Duration::from_secs(7), async {
            loop {
                let a_body = a.snapshot().unwrap().notes[0].body.clone();
                let b_body = b.snapshot().unwrap().notes[0].body.clone();
                if a_body == "long walk outside" && b_body == a_body {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        server.abort();
    }

    #[test]
    fn numeric_ipv6_scope_is_parsed_without_dns() {
        let address: SocketAddr = "[fe80::1234%7]:12345".parse().unwrap();
        assert!(matches!(address, SocketAddr::V6(address) if address.scope_id() == 7));
    }
}
