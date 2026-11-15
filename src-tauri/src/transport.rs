//! Small encrypted snapshot protocol. There are no URLs, HTTP services or relays.
use crate::engine::{Engine, Packet, Peer, MAX_DOCUMENT_BYTES};
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
const MAX_FRAME: usize = MAX_DOCUMENT_BYTES + HEADER_BYTES + 16;
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST: u8 = 1;
const RESPONSE: u8 = 2;
type Result<T> = std::result::Result<T, String>;

pub async fn start(engine: Arc<Engine>) -> Result<()> {
    let listener = bind_listener()?;
    engine.set_port(listener.local_addr().map_err(err)?.port());
    spawn_listener(engine.clone(), listener);
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

fn spawn_listener(engine: Arc<Engine>, listener: TcpListener) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(8));
        loop {
            let Ok((socket, _address)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                drop(socket);
                continue;
            };
            let engine = engine.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = timeout(EXCHANGE_TIMEOUT, serve(engine, socket)).await;
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

async fn serve(engine: Arc<Engine>, mut socket: TcpStream) -> Result<()> {
    let frame = read_frame(&mut socket).await?;
    let packet = engine.packet()?.ok_or("No active network")?;
    let incoming = decrypt(&frame, &packet.network_id, &packet.secret, REQUEST)?;
    let document = engine.accept_document(&packet.network_id, &incoming)?;
    let response = encrypt(
        &Packet {
            network_id: packet.network_id,
            secret: packet.secret,
            document,
        },
        RESPONSE,
    )?;
    write_frame(&mut socket, &response).await
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
        let frame = read_frame(&mut socket).await?;
        let document = decrypt(&frame, &packet.network_id, &packet.secret, RESPONSE)?;
        engine.accept_document(&packet.network_id, &document)?;
        return Ok(());
    }
    Err(last_error)
}

fn encrypt(packet: &Packet, role: u8) -> Result<Vec<u8>> {
    let network = Uuid::parse_str(&packet.network_id).map_err(err)?;
    let nonce: [u8; 24] = rand::random();
    let mut frame = Vec::with_capacity(packet.document.len() + HEADER_BYTES + 16);
    frame.extend_from_slice(MAGIC);
    frame.extend_from_slice(network.as_bytes());
    frame.push(role);
    let cipher = XChaCha20Poly1305::new_from_slice(&packet.secret).map_err(err)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &packet.document,
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
        || frame.len() > MAX_FRAME
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
async fn read_frame(socket: &mut TcpStream) -> Result<Vec<u8>> {
    let length = socket.read_u32().await.map_err(err)? as usize;
    if !(HEADER_BYTES + 16..=MAX_FRAME).contains(&length) {
        return Err("Invalid sync frame size.".into());
    }
    let mut frame = vec![0; length];
    socket.read_exact(&mut frame).await.map_err(err)?;
    Ok(frame)
}
async fn write_frame(socket: &mut TcpStream, frame: &[u8]) -> Result<()> {
    if frame.len() > MAX_FRAME {
        return Err("Sync frame exceeds the size limit.".into());
    }
    socket.write_u32(frame.len() as u32).await.map_err(err)?;
    socket.write_all(frame).await.map_err(err)?;
    socket.flush().await.map_err(err)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
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
