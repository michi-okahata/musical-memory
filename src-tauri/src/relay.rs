//! The relay, hosted by the app itself.
//!
//! Flowing together needs somewhere for the peers to meet. `server/relay.mjs`
//! is that somewhere when there is a machine to run it on; this is the same
//! thing living inside the app, so that the answer to "who sets up the server"
//! is nobody. One debater presses share, their app starts listening, and the
//! address it reports is what the other one types.
//!
//! That matters more than it sounds. The alternative asks a debater to run a
//! node process on tournament wifi ten minutes before a round, and the honest
//! prediction is that it doesn't happen.
//!
//! Like the node relay, this understands the *protocol* and not the flow. The
//! one thing it does with a document is merge it, so that somebody arriving
//! late gets the round so far — see `Room::doc`.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use loro::{ExportMode, LoroDoc};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

/// The port the app asks for first. The dev server's, plus one — the same
/// number the node relay defaults to, so a peer pointed at either finds it.
pub const DEFAULT_PORT: u16 = 1421;

/// Room codes come from this alphabet — no vowels, and none of the characters
/// people mishear when a code is read out across a table. Kept in step with
/// `src/sync/protocol.ts`.
const ROOM_ALPHABET: &str = "bcdfghjkmnpqrstvwxyz23456789";
const ROOM_LENGTH: usize = 6;

/// A room code becomes a filename. It is checked rather than sanitised: there
/// is one shape a code can have, and anything else is a peer we don't
/// understand.
fn is_room_code(code: &str) -> bool {
    code.len() == ROOM_LENGTH && code.chars().all(|c| ROOM_ALPHABET.contains(c))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientMessage {
    Join {
        room: String,
        #[serde(default)]
        peer: Option<String>,
    },
    Doc {
        data: String,
    },
    Presence {
        /// Deliberately never read. Presence is forwarded exactly as it
        /// arrived — the relay has no more business knowing where a cursor is
        /// than it has knowing what an argument says.
        #[serde(rename = "data")]
        _data: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ServerMessage {
    Welcome { room: String, doc: Option<String> },
    Gone { peer: String },
    Error { reason: String },
}

/// What the app tells the frontend once it is listening: the port, and every
/// address on this machine a peer could reach it at.
#[derive(Serialize, Clone)]
pub struct RelayInfo {
    pub port: u16,
    /// This machine's addresses on the networks it is actually on, loopback
    /// excluded — one of these is what the other debater types.
    pub addresses: Vec<String>,
}

struct Room {
    /// The room's document. The relay merges every update into it for one
    /// reason: so the third peer to arrive gets the round so far, even if the
    /// first two have closed their laptops.
    doc: LoroDoc,
    /// Whether anything has ever been written. Tracked rather than asked of the
    /// document, because asking means knowing what an empty flow looks like —
    /// the one thing a relay is built not to know.
    written: bool,
    /// Changed since the last save.
    dirty: bool,
    /// Everything said in this room, tagged with who said it so the sender can
    /// be skipped.
    outbound: broadcast::Sender<(u64, String)>,
}

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

/// A relay that is currently listening.
pub struct RunningRelay {
    pub info: RelayInfo,
    rooms: Rooms,
    dir: PathBuf,
    /// Fires once, and every task watching it stops.
    shutdown: broadcast::Sender<()>,
}

impl RunningRelay {
    /// Write out every room that has changed. Called on the way down, so a
    /// round survives the app quitting.
    fn save_all(&self) {
        let mut rooms = self.rooms.lock().unwrap();
        for (code, room) in rooms.iter_mut() {
            if room.dirty {
                save_room(&self.dir, code, room);
            }
        }
    }
}

impl Drop for RunningRelay {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        self.save_all();
    }
}

/// The relay as the app holds it: at most one, started and stopped by command.
#[derive(Default)]
pub struct RelayState(pub Mutex<Option<RunningRelay>>);

fn room_path(dir: &PathBuf, code: &str) -> PathBuf {
    dir.join(format!("{code}.loro"))
}

fn save_room(dir: &PathBuf, code: &str, room: &mut Room) {
    match room.doc.export(ExportMode::Snapshot) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(room_path(dir, code), bytes) {
                eprintln!("[relay] could not save {code}: {error}");
            } else {
                room.dirty = false;
            }
        }
        Err(error) => eprintln!("[relay] could not encode {code}: {error}"),
    }
}

fn open_room(dir: &PathBuf, code: &str) -> Room {
    let doc = LoroDoc::new();
    let mut written = false;
    if let Ok(bytes) = std::fs::read(room_path(dir, code)) {
        match doc.import(&bytes) {
            // A snapshot we can't read is worse than none: starting empty lets
            // the room work, and the peers still hold the flow between them.
            Err(error) => eprintln!("[relay] {code}: unreadable snapshot ({error})"),
            Ok(_) => written = true,
        }
    }
    Room {
        doc,
        written,
        dirty: false,
        // Capacity is a backlog, not a queue of record: a peer too slow to keep
        // up has fallen far enough behind that the snapshot it gets on
        // reconnecting is the cheaper fix.
        outbound: broadcast::channel(256).0,
    }
}

/// Start listening. The handle owns the relay: dropping it stops the tasks and
/// writes every room out.
pub async fn start(port: u16, dir: PathBuf) -> Result<RunningRelay, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;

    // The asked-for port first, then whatever the OS will give us. A second
    // copy of the app on one machine is an ordinary thing to do — two debaters
    // testing, a window left open from the last round — and it should not be
    // the reason sharing fails.
    let listener = match TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
            .await
            .map_err(|e| format!("cannot listen: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));
    let (shutdown, _) = broadcast::channel(1);
    let connections = AtomicU64::new(0);

    // Accepting.
    {
        let rooms = rooms.clone();
        let dir = dir.clone();
        let shutdown_tx = shutdown.clone();
        let mut stopping = shutdown.subscribe();
        tokio::spawn(async move {
            let connections = connections;
            loop {
                tokio::select! {
                    _ = stopping.recv() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let id = connections.fetch_add(1, Ordering::Relaxed);
                        let rooms = rooms.clone();
                        let dir = dir.clone();
                        let stopping = shutdown_tx.subscribe();
                        tokio::spawn(async move {
                            if let Err(error) = serve(stream, id, rooms, dir, stopping).await {
                                eprintln!("[relay] connection {id}: {error}");
                            }
                        });
                    }
                }
            }
        });
    }

    // Saving. A timer rather than a write per update: a debater types faster
    // than a disk wants to be asked, and the copy that matters during a round
    // is the one in memory.
    {
        let rooms = rooms.clone();
        let dir = dir.clone();
        let mut stopping = shutdown.subscribe();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));
            loop {
                tokio::select! {
                    _ = stopping.recv() => break,
                    _ = ticker.tick() => {
                        let mut rooms = rooms.lock().unwrap();
                        for (code, room) in rooms.iter_mut() {
                            if room.dirty {
                                save_room(&dir, code, room);
                            }
                        }
                    }
                }
            }
        });
    }

    Ok(RunningRelay {
        info: RelayInfo {
            port,
            addresses: local_addresses(),
        },
        rooms,
        dir,
        shutdown,
    })
}

/// One peer, from connection to disconnection.
async fn serve(
    stream: tokio::net::TcpStream,
    id: u64,
    rooms: Rooms,
    dir: PathBuf,
    mut stopping: broadcast::Receiver<()>,
) -> Result<(), String> {
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut source) = ws.split();

    // One task owns the socket's writing end; everything that wants to say
    // something sends it here. Without this the read loop and the room's
    // broadcast would both be holding the same sink.
    let (out, mut outbox) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outbox.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // Set once the peer joins a room; the pair is what its departure is
    // announced with.
    let mut joined: Option<(String, String)> = None;

    loop {
        let message = tokio::select! {
            _ = stopping.recv() => break,
            message = source.next() => match message {
                Some(Ok(message)) => message,
                _ => break,
            },
        };

        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => break,
            // Ping/pong are answered by the library; anything else isn't ours.
            _ => continue,
        };

        let Ok(parsed) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };

        match parsed {
            ClientMessage::Join { room, peer } => {
                if !is_room_code(&room) {
                    let _ = out.send(reply(&ServerMessage::Error {
                        reason: "bad room code".into(),
                    }));
                    continue;
                }

                // Subscribing and reading the snapshot happen under one lock.
                // Apart, an update landing between them would reach neither the
                // snapshot this peer is about to get nor the stream it is about
                // to listen to, and would simply be missing from its flow.
                let (welcome, mut inbox) = {
                    let mut rooms = rooms.lock().unwrap();
                    let entry = rooms
                        .entry(room.clone())
                        .or_insert_with(|| open_room(&dir, &room));
                    let inbox = entry.outbound.subscribe();
                    let doc = entry
                        .written
                        .then(|| entry.doc.export(ExportMode::Snapshot).ok())
                        .flatten()
                        .map(|bytes| BASE64.encode(bytes));
                    (
                        ServerMessage::Welcome {
                            room: room.clone(),
                            doc,
                        },
                        inbox,
                    )
                };
                let _ = out.send(reply(&welcome));

                // Everything the room says from here, minus our own echo.
                let forward = out.clone();
                tokio::spawn(async move {
                    while let Ok((from, payload)) = inbox.recv().await {
                        if from != id && forward.send(Message::Text(payload.into())).is_err() {
                            break;
                        }
                    }
                });

                joined = Some((room, peer.unwrap_or_default()));
            }

            ClientMessage::Doc { ref data } => {
                let Some((room, _)) = joined.as_ref() else {
                    continue;
                };
                if let Ok(bytes) = BASE64.decode(data) {
                    let mut rooms = rooms.lock().unwrap();
                    if let Some(entry) = rooms.get_mut(room) {
                        // Forwarded either way: the peers can merge what this
                        // copy choked on, and a room that keeps working is
                        // worth more than a relay whose snapshot is complete.
                        if let Err(error) = entry.doc.import(&bytes) {
                            eprintln!("[relay] bad update: {error}");
                        }
                        entry.written = true;
                        entry.dirty = true;
                        let _ = entry.outbound.send((id, text.clone()));
                    }
                }
            }

            ClientMessage::Presence { .. } => {
                let Some((room, _)) = joined.as_ref() else {
                    continue;
                };
                let rooms = rooms.lock().unwrap();
                if let Some(entry) = rooms.get(room) {
                    let _ = entry.outbound.send((id, text.clone()));
                }
            }
        }
    }

    // Presence expires on its own, but not for half a minute — saying so now is
    // what takes a closed laptop's cursor off the sheet immediately.
    if let Some((room, peer)) = joined {
        if !peer.is_empty() {
            let rooms = rooms.lock().unwrap();
            if let Some(entry) = rooms.get(&room) {
                let payload = serde_json::to_string(&ServerMessage::Gone { peer }).unwrap();
                let _ = entry.outbound.send((id, payload));
            }
        }
    }

    writer.abort();
    Ok(())
}

fn reply(message: &ServerMessage) -> Message {
    Message::Text(serde_json::to_string(message).unwrap().into())
}

/// Every address on this machine a peer on the same network could reach.
/// Loopback is dropped — it is the one address that is true here and useless
/// to anybody else, which is exactly the mistake this whole feature exists to
/// stop somebody making.
fn local_addresses() -> Vec<String> {
    let Ok(interfaces) = local_ip_address::list_afinet_netifas() else {
        return Vec::new();
    };
    let mut addresses: Vec<String> = interfaces
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            IpAddr::V4(v4)
                if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() =>
            {
                Some(v4.to_string())
            }
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}
