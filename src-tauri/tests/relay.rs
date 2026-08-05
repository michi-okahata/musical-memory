//! The hosted relay, exercised the way the app uses it.
//!
//! Two things are worth a test here and neither is provable by reading the
//! code. One is the protocol: a peer arriving late has to be handed the round
//! so far, and a peer leaving has to be announced, and both of those are about
//! what happens *between* connections. The other is the format — the app writes
//! its flow with loro-crdt in JavaScript and this reads it with the `loro`
//! crate, and "same version number" is not the same claim as "same bytes".

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use loro::{ExportMode, LoroDoc};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_message(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("timed out waiting for the relay")
            .expect("socket closed")
            .expect("socket error");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).expect("relay sent something that isn't JSON");
        }
    }
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("could not send");
}

/// A flow with one argument in it, as the app would write it.
fn a_flow(text: &str) -> LoroDoc {
    let doc = LoroDoc::new();
    let tree = doc.get_tree("flow");
    tree.enable_fractional_index(0);
    let node = tree.create(None).unwrap();
    let map = tree.get_meta(node).unwrap();
    map.insert_container("text", loro::LoroText::new())
        .unwrap()
        .insert(0, text)
        .unwrap();
    map.insert("speech", 0).unwrap();
    doc.commit();
    doc
}

fn text_of(doc: &LoroDoc) -> String {
    let tree = doc.get_tree("flow");
    let root = tree.roots()[0];
    let map = tree.get_meta(root).unwrap();
    map.get("text")
        .unwrap()
        .into_container()
        .unwrap()
        .into_text()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn carries_the_room_between_peers() {
    let dir = std::env::temp_dir().join(format!("flow-relay-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // Port 0: the OS picks, so tests don't fight each other or a real app.
    let relay = flow_lib::relay::start(0, dir.clone()).await.expect("start");
    let url = format!("ws://127.0.0.1:{}", relay.info.port);

    // The first peer finds an empty room.
    let (mut a, _) = connect_async(&url).await.expect("connect a");
    send(&mut a, json!({ "t": "join", "room": "bcdfgh", "peer": "111" })).await;
    let welcome = next_message(&mut a).await;
    assert_eq!(welcome["t"], "welcome");
    assert!(welcome["doc"].is_null(), "a fresh room has no document yet");

    // …and writes a flow into it.
    let doc = a_flow("econ decline bad");
    let update = BASE64.encode(doc.export(ExportMode::Snapshot).unwrap());
    send(&mut a, json!({ "t": "doc", "data": update })).await;

    // The second peer arrives to find the round already in progress. This is
    // the whole reason the relay keeps a document at all.
    let (mut b, _) = connect_async(&url).await.expect("connect b");
    send(&mut b, json!({ "t": "join", "room": "bcdfgh", "peer": "222" })).await;
    let welcome = next_message(&mut b).await;
    let carried = LoroDoc::new();
    carried
        .import(&BASE64.decode(welcome["doc"].as_str().expect("a document")).unwrap())
        .expect("import what the relay handed us");
    assert_eq!(text_of(&carried), "econ decline bad");

    // Presence goes across untouched, and does not come back to its sender.
    send(&mut b, json!({ "t": "presence", "data": "aGVsbG8=" })).await;
    let seen = next_message(&mut a).await;
    assert_eq!(seen["t"], "presence");
    assert_eq!(seen["data"], "aGVsbG8=");

    // A peer that goes away is announced at once, rather than being waited out.
    drop(b);
    let seen = next_message(&mut a).await;
    assert_eq!(seen["t"], "gone");
    assert_eq!(seen["peer"], "222");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn refuses_a_room_code_that_could_be_a_path() {
    let dir = std::env::temp_dir().join(format!("flow-relay-bad-{}", std::process::id()));
    let relay = flow_lib::relay::start(0, dir.clone()).await.expect("start");
    let url = format!("ws://127.0.0.1:{}", relay.info.port);

    let (mut peer, _) = connect_async(&url).await.expect("connect");
    send(&mut peer, json!({ "t": "join", "room": "../../etc/passwd", "peer": "1" })).await;
    let reply = next_message(&mut peer).await;
    assert_eq!(reply["t"], "error");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The format the app writes, read by the relay that has to merge it. The
/// fixture is a real snapshot from `src/model/flow.ts`, written by loro-crdt in
/// Node — see the note at the top of this file for why that isn't obvious.
#[test]
fn reads_a_flow_written_by_the_javascript_side() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/js-snapshot.loro"),
    )
    .expect("fixture");

    let doc = LoroDoc::new();
    doc.import(&bytes).expect("import a JS-written snapshot");

    let tree = doc.get_tree("flow");
    let roots = tree.roots();
    assert_eq!(roots.len(), 1);
    assert_eq!(text_of(&doc), "econ decline bad");

    // The response, and the peer registry the sheet attributes arguments with.
    let children = tree.children(Some(roots[0])).unwrap();
    assert_eq!(children.len(), 1);
    let peers = doc.get_map("peers");
    assert_eq!(peers.len(), 1, "the JS side registered its peer");
}
