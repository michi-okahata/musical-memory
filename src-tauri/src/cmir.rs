use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// CardMirror files (`.cmir`), as somewhere to recall from.
///
/// A `.cmir` is a gzip-wrapped JSON envelope around a ProseMirror document, and
/// the shape of that document is already the shape of a block:
///
///   - a `block` is a Heading 3 — the argument;
///   - the cards and analytics under it are `card` and `analytic_unit` nodes,
///     each headed by a `tag` or an `analytic` — the answers;
///   - the `hat` above it is what the whole lot is a position on.
///
/// So a file full of cards is a file full of blocks, and nothing here invents a
/// structure to hold them. What does *not* come across is the card bodies: a
/// flow holds what you would say, not the evidence under the tag. This reads
/// the format and no more — which two arguments are the same argument is still
/// the frontend's, which is why a `Section` carries no key.

/// The extension, matched without regard to case — a `Politics.CMIR` skipped in
/// silence is a block the user thinks they imported and hasn't.
const EXTENSION: &str = "cmir";

/// The most a single file may be, compressed and inflated. Far above anything
/// real, and there for what a file can be *made* to do: gzip reaches a thousand
/// to one on text, and a backfile is a thing people swap. Over either cap is
/// skipped and counted as unreadable.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_INFLATED_BYTES: usize = 512 * 1024 * 1024;

/// The magic in the envelope. Rejects arbitrary JSON that happens to be gzipped.
const FORMAT: &str = "cardmirror-doc";

/// The newest envelope this knows how to read. A file that says it is newer is
/// refused rather than guessed at — the same thing CardMirror's own parser does,
/// and for the same reason: a format version exists to be believed.
const VERSION: u64 = 1;

/// How deep to look inside a node for cards. Cards sit directly under a block in
/// every ordinary file; the depth is for the wrappers that hold copies of
/// somebody else's cards, and the cap is so a file that nests them into each
/// other cannot take the walk with it.
const MAX_DEPTH: usize = 8;

/// How far down a directory tree to look, and how many files to take from it.
/// Pointing this at a home directory should cost a moment and stop, not walk a
/// disk — and a backfile that really is deeper than this is one the user can
/// point at more precisely.
const MAX_DIRECTORY_DEPTH: usize = 12;
const MAX_FILES: usize = 20_000;

/// One `block` heading and the tags under it, as read.
#[derive(Serialize, Debug)]
pub struct Section {
    /// The `hat` this block sits under, or the `pocket` when there is no hat,
    /// or empty. What the frontend turns into a position — including the choice
    /// of what to call one that came in with nothing, which is a question about
    /// sheets and not about files.
    pub position: String,
    /// The block heading, whitespace collapsed.
    pub argument: String,
    /// The tag of every card and the text of every analytic under it, in
    /// document order.
    pub answers: Vec<String>,
}

/// One file's worth.
#[derive(Serialize)]
pub struct CmirFile {
    /// The full path, which is also what the store files these blocks under —
    /// so re-reading a file replaces exactly its own blocks and no others.
    pub path: String,
    pub sections: Vec<Section>,
}

/// What a directory turned out to hold.
#[derive(Serialize)]
pub struct Scan {
    /// The folder, as the filesystem spells it — see `cmir_read_dir`. What the
    /// blocks are filed under, so that the same folder reached by two different
    /// spellings of its path is one folder and not two.
    pub dir: String,
    pub files: Vec<CmirFile>,
    /// How many `.cmir` files would not read. Counted rather than raised: one
    /// damaged file in a backfile of six hundred should cost you that file, and
    /// a number on the status line is how you find out it did.
    pub failed: usize,
    /// Whether the walk stopped before it ran out of folder — see `MAX_FILES`
    /// and `MAX_DIRECTORY_DEPTH`. A partial read that says nothing is a partial
    /// read the user takes for the whole thing, and the import that follows
    /// deletes what it didn't find.
    pub truncated: bool,
}

/// True when `bytes` is a gzip stream. The other thing a `.cmir` can be is
/// plaintext JSON, which begins with `{` — the two never collide, which is what
/// lets a reader tell them apart without being told.
fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Inflate, up to `MAX_INFLATED_BYTES`. Read one byte past the cap so a stream
/// that would have gone on is told from one that ended on the line.
fn inflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_INFLATED_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("not a CardMirror file: {e}"))?;
    if out.len() > MAX_INFLATED_BYTES {
        return Err("CardMirror file inflates to more than this will read".into());
    }
    Ok(out)
}

/// A node's type name, or "" for anything that isn't a node.
fn kind(node: &Value) -> &str {
    node["type"].as_str().unwrap_or("")
}

/// All the text under a node, with the runs joined and the whitespace collapsed.
///
/// Marks are dropped on the way through. Which words in a card are highlighted
/// is the whole point of the card and means nothing as a line on a flow, where
/// what you have is one row of shorthand and no room to say anything twice.
fn text(node: &Value) -> String {
    let mut out = String::new();
    gather(node, &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn gather(node: &Value, out: &mut String) {
    if let Some(t) = node["text"].as_str() {
        out.push_str(t);
        return;
    }
    if let Some(children) = node["content"].as_array() {
        for child in children {
            gather(child, out);
        }
    }
}

/// The head of a card is its tag; the head of an analytic unit is its analytic.
/// Both are the first child, which is what their schema requires of them.
fn head(node: &Value) -> String {
    node["content"]
        .as_array()
        .and_then(|children| children.first())
        .map(text)
        .unwrap_or_default()
}

/// Every card head inside `node`, appended to `answers`.
///
/// Cards are ordinarily siblings of the block heading, so this usually looks at
/// one node and takes one line off it. The descent is for the wrappers that
/// hold a copy of another document's cards: those cards are under this block on
/// the page, so they are answers to this argument, and a heading that has been
/// copied in with them cannot end the section — it is inside the wrapper rather
/// than beside it, which is the same reason CardMirror's own section walk can't
/// see it either.
fn heads(node: &Value, depth: usize, answers: &mut Vec<String>) {
    match kind(node) {
        "card" | "analytic_unit" => {
            let line = head(node);
            if !line.is_empty() {
                answers.push(line);
            }
        }
        _ => {
            if depth >= MAX_DEPTH {
                return;
            }
            if let Some(children) = node["content"].as_array() {
                for child in children {
                    heads(child, depth + 1, answers);
                }
            }
        }
    }
}

/// Walk the document and gather one section per block heading.
///
/// The top level is a flat sequence, not a tree: the hierarchy is in the heading
/// levels, and a heading owns everything after it until one at its level or
/// above. So this carries the current pocket and hat along and opens a section
/// at each block. A card before the first block heading is dropped — an answer
/// needs an argument to be an answer to. Two blocks that say the same thing stay
/// two sections; merging them is a question about arguments, not files.
fn sections_in(nodes: &[Value]) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    let mut pocket = String::new();
    let mut hat = String::new();
    let mut open: Option<usize> = None;

    for node in nodes {
        match kind(node) {
            "pocket" => {
                pocket = text(node);
                hat.clear();
                open = None;
            }
            "hat" => {
                hat = text(node);
                open = None;
            }
            "block" => {
                let argument = text(node);
                open = if argument.is_empty() {
                    // Nothing can be recalled by an argument that is nothing, so
                    // the cards under an empty heading have nowhere to go.
                    None
                } else {
                    out.push(Section {
                        position: if hat.is_empty() { pocket.clone() } else { hat.clone() },
                        argument,
                        answers: Vec::new(),
                    });
                    Some(out.len() - 1)
                };
            }
            _ => {
                if let Some(at) = open {
                    heads(node, 0, &mut out[at].answers);
                }
            }
        }
    }

    // A block with no cards under it is a heading, not a block. Kept out here
    // rather than at the store, where a block with no answers means "forget
    // this one" and would delete something the user memorized themselves.
    out.retain(|section| !section.answers.is_empty());
    out
}

/// Read one file's blocks.
pub fn sections(bytes: &[u8]) -> Result<Vec<Section>, String> {
    if bytes.is_empty() {
        return Err("empty file".into());
    }
    let raw = if is_gzip(bytes) {
        inflate(bytes)?
    } else {
        bytes.to_vec()
    };
    let file: Value =
        serde_json::from_slice(&raw).map_err(|e| format!("not a CardMirror file: {e}"))?;

    if file["format"].as_str() != Some(FORMAT) {
        return Err("not a CardMirror file".into());
    }
    let version = file["formatVersion"]
        .as_u64()
        .ok_or_else(|| "CardMirror file has no formatVersion".to_string())?;
    if version > VERSION {
        return Err(format!("CardMirror file is version {version}, newer than this build reads"));
    }
    let Some(content) = file["doc"]["content"].as_array() else {
        return Ok(Vec::new());
    };
    Ok(sections_in(content))
}

/// Every `.cmir` under `dir`, sorted, so importing the same folder twice reads
/// it in the same order twice.
///
/// Symbolic links are not followed: a link back up the tree is how a walk like
/// this never finishes. `cut` is set when either cap stopped it short — the
/// import that follows deletes everything under the folder and puts back what
/// was found, so a walk that quietly gave up would take the rest of somebody's
/// backfile with it.
fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, cut: &mut bool) {
    if out.len() >= MAX_FILES {
        *cut = true;
        return;
    }
    if depth > MAX_DIRECTORY_DEPTH {
        *cut = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            *cut = true;
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            scan(&path, depth + 1, out, cut);
        } else if is_cmir(&path) {
            out.push(path);
        }
    }
}

/// Whether a path names a CardMirror file, whatever case it was saved in.
fn is_cmir(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

/// Read every `.cmir` under `dir`.
///
/// The whole directory in one call, the way a round is read in one call: a file
/// at a time would be a thousand trips across for a job that is one job.
///
/// The folder is resolved first, and the resolved form is what comes back for
/// the import to file blocks under. `Backfiles` and `backfiles` are one
/// directory on a Mac and either can come back from a dialog, so resolving is
/// what makes a second import replace the first rather than double it.
#[tauri::command]
pub fn cmir_read_dir(dir: String) -> Result<Scan, String> {
    let root = fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{dir}: not a folder"));
    }
    let mut paths = Vec::new();
    let mut truncated = false;
    scan(&root, 0, &mut paths, &mut truncated);
    paths.sort();

    let mut files = Vec::new();
    let mut failed = 0;
    for path in paths {
        // Size before contents: the point of the cap is not to have read it.
        let too_big = fs::metadata(&path).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true);
        if too_big {
            failed += 1;
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            failed += 1;
            continue;
        };
        match sections(&bytes) {
            Ok(sections) => files.push(CmirFile {
                path: path.to_string_lossy().into_owned(),
                sections,
            }),
            Err(_) => failed += 1,
        }
    }
    Ok(Scan {
        dir: root.to_string_lossy().into_owned(),
        files,
        failed,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::{cmir_read_dir, is_gzip, sections};
    use serde_json::json;

    /// A `.cmir`'s bytes, uncompressed — which the reader takes as readily as a
    /// compressed one, and which keeps these tests readable.
    fn file(content: Vec<serde_json::Value>) -> Vec<u8> {
        json!({
            "format": "cardmirror-doc",
            "formatVersion": 1,
            "createdBy": "test",
            "createdAt": "2026-08-11T00:00:00.000Z",
            "doc": { "type": "doc", "content": content },
        })
        .to_string()
        .into_bytes()
    }

    fn heading(kind: &str, text: &str) -> serde_json::Value {
        json!({ "type": kind, "content": [{ "type": "text", "text": text }] })
    }

    /// A card: a tag, a cite and a paragraph of the evidence itself.
    fn card(tag: &str, body: &str) -> serde_json::Value {
        json!({
            "type": "card",
            "content": [
                heading("tag", tag),
                { "type": "cite_paragraph", "content": [{ "type": "text", "text": "Smith 24" }] },
                { "type": "card_body", "content": [{ "type": "text", "text": body }] },
            ],
        })
    }

    fn analytic(text: &str) -> serde_json::Value {
        json!({ "type": "analytic_unit", "content": [heading("analytic", text)] })
    }

    #[test]
    fn a_block_and_its_cards_are_an_argument_and_its_answers() {
        let read = sections(&file(vec![
            heading("hat", "Assurance DA"),
            heading("block", "AT: No Link"),
            card("Link is overwhelming", "The evidence, at length."),
            analytic("They conceded the link wall"),
        ]))
        .unwrap();

        assert_eq!(read.len(), 1);
        assert_eq!(read[0].position, "Assurance DA");
        assert_eq!(read[0].argument, "AT: No Link");
        assert_eq!(
            read[0].answers,
            ["Link is overwhelming", "They conceded the link wall"]
        );
    }

    #[test]
    fn the_evidence_itself_never_comes_across() {
        let read = sections(&file(vec![
            heading("block", "AT: No Link"),
            card("Link is overwhelming", "Nuclear war is coming and here is why."),
        ]))
        .unwrap();
        assert_eq!(read[0].answers, ["Link is overwhelming"]);
    }

    #[test]
    fn a_block_belongs_to_the_hat_above_it() {
        let read = sections(&file(vec![
            heading("pocket", "Politics"),
            heading("hat", "Midterms DA"),
            heading("block", "Uniqueness"),
            card("Dems are ahead", "…"),
            heading("hat", "Court Clog CP"),
            heading("block", "Solvency"),
            card("The CP solves", "…"),
        ]))
        .unwrap();
        let at: Vec<_> = read.iter().map(|s| s.position.as_str()).collect();
        assert_eq!(at, ["Midterms DA", "Court Clog CP"]);
    }

    #[test]
    fn a_block_with_no_hat_falls_back_to_the_pocket() {
        let read = sections(&file(vec![
            heading("pocket", "Kritik answers"),
            heading("block", "Perm do both"),
            card("Perm solves", "…"),
        ]))
        .unwrap();
        assert_eq!(read[0].position, "Kritik answers");
    }

    #[test]
    fn a_hat_ends_the_block_before_it() {
        let read = sections(&file(vec![
            heading("hat", "Cap K"),
            heading("block", "Links"),
            card("Link — growth", "…"),
            heading("hat", "Framework"),
            // Loose under the new hat, with no block heading of its own.
            card("Fairness first", "…"),
        ]))
        .unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].answers, ["Link — growth"]);
    }

    #[test]
    fn cards_before_the_first_block_are_dropped() {
        let read = sections(&file(vec![
            card("Nowhere to go", "…"),
            heading("block", "Somewhere"),
            card("Here", "…"),
        ]))
        .unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].answers, ["Here"]);
    }

    #[test]
    fn a_block_with_nothing_under_it_is_not_a_block() {
        let read = sections(&file(vec![
            heading("block", "Empty"),
            heading("block", "Full"),
            card("Something", "…"),
        ]))
        .unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].argument, "Full");
    }

    #[test]
    fn cards_copied_in_from_another_file_still_count() {
        let read = sections(&file(vec![
            heading("block", "AT: Politics"),
            json!({
                "type": "transclusion_ref",
                "content": [card("Winners win", "…"), analytic("Thumper")],
            }),
        ]))
        .unwrap();
        assert_eq!(read[0].answers, ["Winners win", "Thumper"]);
    }

    #[test]
    fn the_same_heading_twice_is_two_sections_to_be_merged_upstairs() {
        let read = sections(&file(vec![
            heading("block", "AT: Cap"),
            card("First", "…"),
            heading("block", "AT: Cap"),
            card("Second", "…"),
        ]))
        .unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].argument, read[1].argument);
    }

    #[test]
    fn heading_text_arrives_with_its_whitespace_collapsed() {
        let read = sections(&file(vec![
            json!({
                "type": "block",
                "content": [
                    { "type": "text", "text": "  AT:  " },
                    { "type": "text", "text": "No\n Link " },
                ],
            }),
            card("x", "…"),
        ]))
        .unwrap();
        assert_eq!(read[0].argument, "AT: No Link");
    }

    #[test]
    fn refuses_anything_that_is_not_a_cardmirror_file() {
        assert!(sections(b"").is_err());
        assert!(sections(b"not json at all").is_err());
        assert!(sections(br#"{"format":"something-else","formatVersion":1}"#).is_err());
    }

    #[test]
    fn refuses_a_file_from_a_newer_build() {
        let bytes = serde_json::json!({
            "format": "cardmirror-doc",
            "formatVersion": 2,
            "doc": { "type": "doc", "content": [] },
        })
        .to_string()
        .into_bytes();
        assert!(sections(&bytes).is_err());
    }

    /// The walk: every `.cmir` under the folder however deep, nothing that
    /// isn't one, and a file that won't read costing itself and nothing else.
    #[test]
    fn reads_a_folder_of_files() {
        use std::io::Write;

        let dir = std::env::temp_dir().join("flow-cmir-folder");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("das")).unwrap();

        // Compressed, the way CardMirror writes them.
        let plain = file(vec![
            heading("hat", "Politics DA"),
            heading("block", "AT: No Link"),
            card("Link is overwhelming", "…"),
        ]);
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&plain).unwrap();
        std::fs::write(dir.join("politics.cmir"), encoder.finish().unwrap()).unwrap();

        // Nested, and uncompressed — an older file, which still opens.
        std::fs::write(
            dir.join("das").join("assurance.cmir"),
            file(vec![heading("block", "Uniqueness"), card("It is unique", "…")]),
        )
        .unwrap();

        // Saved in the wrong case — one directory listing on a Mac, and still a
        // CardMirror file.
        std::fs::write(
            dir.join("SHOUTING.CMIR"),
            file(vec![heading("block", "Loud"), card("Very", "…")]),
        )
        .unwrap();

        // Neither of these may cost anything but itself.
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        std::fs::write(dir.join("damaged.cmir"), "not a cardmirror file").unwrap();

        let read = cmir_read_dir(dir.to_string_lossy().into_owned()).unwrap();

        assert_eq!(read.failed, 1);
        assert!(!read.truncated);
        assert_eq!(read.files.len(), 3);
        // Sorted, so the same folder reads the same way twice.
        let names: Vec<&str> = read
            .files
            .iter()
            .map(|f| f.path.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(names, ["SHOUTING.CMIR", "assurance.cmir", "politics.cmir"]);
        let politics = read.files.last().unwrap();
        assert_eq!(politics.sections[0].position, "Politics DA");
        assert_eq!(politics.sections[0].answers, ["Link is overwhelming"]);
        // The folder comes back resolved, and every file is under it.
        assert!(read.files.iter().all(|f| f.path.starts_with(&read.dir)));
    }

    /// A file that inflates to more than the cap is skipped, not swallowed.
    /// A hundred megabytes of one repeated byte compresses to a few hundred
    /// kilobytes — the shape of the thing this guards against.
    #[test]
    fn refuses_a_file_that_inflates_without_end() {
        use std::io::Write;

        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let chunk = vec![b'a'; 1024 * 1024];
        for _ in 0..(super::MAX_INFLATED_BYTES / chunk.len()) + 2 {
            encoder.write_all(&chunk).unwrap();
        }
        let bomb = encoder.finish().unwrap();

        assert!(bomb.len() < 4 * 1024 * 1024, "the point is that it is small");
        let err = sections(&bomb).unwrap_err();
        assert!(err.contains("inflates"), "{err}");
    }

    #[test]
    fn a_folder_that_is_not_there_is_an_error_rather_than_an_empty_read() {
        let missing = std::env::temp_dir().join("flow-cmir-nowhere");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(cmir_read_dir(missing.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn reads_a_compressed_file_the_same_as_a_plain_one() {
        use std::io::Write;
        let plain = file(vec![heading("block", "AT: No Link"), card("Answer", "…")]);
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&plain).unwrap();
        let compressed = encoder.finish().unwrap();

        assert!(is_gzip(&compressed));
        assert_eq!(
            sections(&compressed).unwrap()[0].argument,
            sections(&plain).unwrap()[0].argument
        );
    }
}
