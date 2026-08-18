use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// `~/.flow`: what the *user* keeps, as against what a round does.
///
/// A round is a folder the user picked, theirs to copy and hand over (see
/// `files.rs`). This is the other half — what follows the person from round to
/// round. One directory, always in the same place: the blocks are the database
/// in it, `~/.flow/db`, and settings later go in beside them.
///
/// What it holds is blocks: an argument, and the answers to it, in order. Each
/// carries the *position* it belongs to — nothing more than the title of the
/// sheet it was memorized on, which costs no keystroke and keeps a framework
/// block out of your way while you answer a disadvantage. A block memorized on
/// an untitled sheet has no position, which is a perfectly good place to be;
/// positions are a filter, not a filing requirement.
///
/// Blocks also come in from CardMirror files (see `cmir.rs`), and which of the
/// two a block is is its *source*: empty for one you memorized, the file's path
/// otherwise. They have to be kept apart. What you memorized is edited on the
/// memory sheet and written back from it, so a block on the disk and not on
/// that sheet is one you deleted — which a file's block is not. So the sheet
/// only ever sees source `''`, and the two ways a block gets here never write
/// each other's rows.
///
/// A database rather than another JSON file because this one is written *into*
/// while a round is being flowed: rewriting a season of blocks to record that
/// one changed is how somebody eventually loses the lot.
///
/// Nothing here knows what an argument *means*, or when two of them are the
/// same argument. It stores the lines and hands them back — matching is the
/// frontend's (see `src/memory/recall.ts`), which is why `key` is a value this
/// is *given* rather than one it works out.

/// The directory, under the user's home directory.
const DIR: &str = ".flow";

/// The database in it. Named for what it is rather than for the app, because
/// everything in this directory belongs to the app and the name that has to
/// tell them apart is the one between them.
const FILE: &str = "db";

/// What the user has changed about the keys, beside it. JSON and not a table
/// in the database next door, because this one is written by *hand*: it is
/// opened in a text editor, and a row in a SQLite file cannot be.
const CONFIG: &str = "config.json";

/// The schema. One step, because nothing has shipped yet and so there is no
/// file anywhere that was written by an older build of this — the current
/// schema and the whole history of it are the same thing.
///
/// `PRAGMA user_version` records how many steps a file has had, which is what
/// makes the next one cheap: once there are stores in the world, a change is a
/// step appended here and never an edit to the one below it.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE block (
        source       TEXT NOT NULL,
        position     TEXT NOT NULL,
        key          TEXT NOT NULL,
        argument     TEXT NOT NULL,
        memorized_at INTEGER NOT NULL,
        PRIMARY KEY (source, position, key)
     );
     CREATE TABLE answer (
        source   TEXT NOT NULL,
        position TEXT NOT NULL,
        key      TEXT NOT NULL,
        ordinal  INTEGER NOT NULL,
        text     TEXT NOT NULL,
        PRIMARY KEY (source, position, key, ordinal)
     )",
];

/// An argument and the answers to it.
#[derive(Serialize)]
pub struct Block {
    /// Where it came from: empty for a block the user memorized, and otherwise
    /// the path of the file it was read out of. See the note above on why the
    /// two are kept apart.
    pub source: String,
    /// The position it belongs to — the title of the sheet it was memorized
    /// on. Empty for a block that has none, which groups them all together.
    pub position: String,
    /// What the frontend matches an argument on the sheet against — a
    /// normalised form of the argument, and opaque to everything here.
    pub key: String,
    /// The argument as it was actually written, so that somebody opening this
    /// file with `sqlite3` can read what they have memorized.
    pub argument: String,
    /// The answers, in the order they were flowed in.
    pub answers: Vec<String>,
}

/// Every error out of here names the file: a `.flow` that won't open is the one
/// thing the frontend cannot work out for itself.
fn at(path: &Path) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

/// Bring a file up to the current schema, whatever version it was left at.
///
/// Each step and the version it takes the file to go in one transaction, so a
/// crash between them leaves a file that is at one version or the other and
/// never half-way between.
fn migrate(db: &Connection) -> rusqlite::Result<()> {
    steps_of(db, MIGRATIONS)
}

/// The runner, over whatever list it is given. Split from `migrate` so it can
/// be tested against more than one step — `MIGRATIONS` holds one today, which
/// makes running it a poor test of running a list.
fn steps_of(db: &Connection, steps: &[&str]) -> rusqlite::Result<()> {
    let done: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (i, step) in steps.iter().enumerate().skip(done as usize) {
        db.execute_batch(&format!(
            "BEGIN; {step}; PRAGMA user_version = {}; COMMIT;",
            i + 1
        ))?;
    }
    Ok(())
}

/// Open the store, creating it if this is the first time the app has run.
fn open(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(at(path))?;
    migrate(&db).map_err(at(path))?;
    Ok(db)
}

/// Where the store lives, with the directory made on the way past. Not
/// configurable, and deliberately: a file you have to be told the location of is
/// one that gets left behind on the old machine.
fn store_in(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(FILE))
}

/// The settings file, in the same directory and made by the same call — so a
/// machine that has never run this ends up with the directory either way.
fn config_in(home: &Path) -> Result<PathBuf, String> {
    Ok(store_in(home)?.with_file_name(CONFIG))
}

/// Its contents, or `None` where there is no file — which is every machine
/// until somebody writes one, and so is not a failure. A file that exists and
/// cannot be read is: that is a config somebody wrote and is not getting.
fn read_config(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home directory: {e}"))?;
    store_in(&home)
}

/// The blocks of one kind — `mine` for the ones the user memorized, and its
/// opposite for the ones read out of files.
///
/// Separately, because they change at completely different rates: the memorized
/// ones are re-read each time the memory sheet writes, and there can be a
/// hundred thousand imported ones. Either half in one call, since an argument is
/// looked up every time the cursor moves and that must not reach the disk.
fn blocks(db: &Connection, mine: bool) -> rusqlite::Result<Vec<Block>> {
    let mut query = db.prepare(
        "SELECT block.source, block.position, block.key, block.argument, answer.text
         FROM block JOIN answer
           ON answer.source = block.source
          AND answer.position = block.position
          AND answer.key = block.key
         WHERE (block.source = '') = ?1
         ORDER BY block.source, block.position, block.key, answer.ordinal",
    )?;
    let rows = query.query_map([mine as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    // One row per answer, gathered back into one entry per block — the join is
    // ordered by source, position and key, so each block's rows arrive together.
    let mut out: Vec<Block> = Vec::new();
    for row in rows {
        let (source, position, key, argument, answer) = row?;
        match out.last_mut() {
            Some(block)
                if block.key == key && block.position == position && block.source == source =>
            {
                block.answers.push(answer)
            }
            _ => out.push(Block {
                source,
                position,
                key,
                argument,
                answers: vec![answer],
            }),
        }
    }
    Ok(out)
}

/// Memorize `answers` as the answers to `argument`, replacing whatever was
/// memorized under that key before.
///
/// Replacing rather than merging, because the sheet is what you are memorizing
/// *from* — a store that kept the version you had edited away would give you
/// back answers you deliberately stopped making. No answers forgets the block.
/// Only ever the user's own: a file's are not `m`'s to write or delete.
fn memorize(
    db: &mut Connection,
    position: &str,
    key: &str,
    argument: &str,
    answers: &[String],
) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM answer WHERE source = '' AND position = ?1 AND key = ?2",
        [position, key],
    )?;
    tx.execute(
        "DELETE FROM block WHERE source = '' AND position = ?1 AND key = ?2",
        [position, key],
    )?;
    if !answers.is_empty() {
        tx.execute(
            "INSERT INTO block (source, position, key, argument, memorized_at)
             VALUES ('', ?1, ?2, ?3, strftime('%s', 'now'))",
            [position, key, argument],
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO answer (source, position, key, ordinal, text)
             VALUES ('', ?1, ?2, ?3, ?4)",
        )?;
        for (ordinal, answer) in answers.iter().enumerate() {
            insert.execute(rusqlite::params![position, key, ordinal as i64, answer])?;
        }
    }
    tx.commit()
}

/// `~/.flow/config.json`, as text, or null where there is none.
///
/// Text and not a parsed shape: what a key may be bound to is the frontend's
/// question (see `src/editor/config.ts`), and a config half-understood on the
/// way through here would be one whose mistakes are reported twice, in two
/// vocabularies.
#[tauri::command]
pub fn store_config(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home directory: {e}"))?;
    read_config(&config_in(&home)?)
}

#[tauri::command]
pub fn store_memorized(app: tauri::AppHandle) -> Result<Vec<Block>, String> {
    let path = path(&app)?;
    blocks(&open(&path)?, true).map_err(at(&path))
}

#[tauri::command]
pub fn store_imported(app: tauri::AppHandle) -> Result<Vec<Block>, String> {
    let path = path(&app)?;
    blocks(&open(&path)?, false).map_err(at(&path))
}

#[tauri::command]
pub fn store_memorize(
    app: tauri::AppHandle,
    position: String,
    key: String,
    argument: String,
    answers: Vec<String>,
) -> Result<(), String> {
    let path = path(&app)?;
    memorize(&mut open(&path)?, &position, &key, &argument, &answers).map_err(at(&path))
}

/// Move every block in `from` to `to`, keeping their answers — which is what
/// renaming a position is.
///
/// A block already under `to` answering the same argument is replaced: the key
/// does not allow two, and the one carried in is the one the user just named.
/// The user's own only — a position on a file's blocks is the hat it was written
/// under, and renaming a sheet is not a claim about somebody's backfile.
fn rename_position(db: &mut Connection, from: &str, to: &str) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM answer WHERE source = '' AND position = ?1
           AND key IN (SELECT key FROM block WHERE source = '' AND position = ?2)",
        [to, from],
    )?;
    tx.execute(
        "DELETE FROM block WHERE source = '' AND position = ?1
           AND key IN (SELECT key FROM block WHERE source = '' AND position = ?2)",
        [to, from],
    )?;
    tx.execute(
        "UPDATE block SET position = ?1 WHERE source = '' AND position = ?2",
        [to, from],
    )?;
    tx.execute(
        "UPDATE answer SET position = ?1 WHERE source = '' AND position = ?2",
        [to, from],
    )?;
    tx.commit()
}

#[tauri::command]
pub fn store_rename_position(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<(), String> {
    let path = path(&app)?;
    rename_position(&mut open(&path)?, &from, &to).map_err(at(&path))
}

/// One block on its way in from a file. The same four fields a memorized block
/// has, because it is the same thing — the key included, which the frontend has
/// worked out with the same rule it matches by.
#[derive(Deserialize)]
pub struct Imported {
    pub position: String,
    pub key: String,
    pub argument: String,
    pub answers: Vec<String>,
}

/// One file's worth of them.
#[derive(Deserialize)]
pub struct ImportedFile {
    /// The file's path, which is what its blocks are filed under.
    pub source: String,
    pub blocks: Vec<Imported>,
}

/// The path prefix that means "inside this folder". Built with a separator on
/// the end so that `/backfiles/da` cannot claim `/backfiles/das`.
fn under(dir: &str) -> String {
    let mut prefix = dir.trim_end_matches(['/', '\\']).to_string();
    prefix.push(std::path::MAIN_SEPARATOR);
    prefix
}

/// Replace everything read out of `dir` with `files`.
///
/// Everything, because a file renamed or deleted since the last read leaves
/// blocks nothing on the disk says any more — safe to do because it is one
/// transaction, so a scan that fails half-way leaves what was there. Nothing
/// here touches an empty source: the prefix always has a separator, `''` does
/// not.
fn import(db: &mut Connection, dir: &str, files: &[ImportedFile]) -> rusqlite::Result<()> {
    let prefix = under(dir);
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM answer WHERE substr(source, 1, length(?1)) = ?1",
        [&prefix],
    )?;
    tx.execute(
        "DELETE FROM block WHERE substr(source, 1, length(?1)) = ?1",
        [&prefix],
    )?;

    {
        let mut add_block = tx.prepare(
            "INSERT INTO block (source, position, key, argument, memorized_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))",
        )?;
        let mut add_answer = tx.prepare(
            "INSERT INTO answer (source, position, key, ordinal, text)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for file in files {
            for block in &file.blocks {
                if block.key.is_empty() || block.answers.is_empty() {
                    continue;
                }
                add_block.execute(rusqlite::params![
                    file.source,
                    block.position,
                    block.key,
                    block.argument,
                ])?;
                for (ordinal, answer) in block.answers.iter().enumerate() {
                    add_answer.execute(rusqlite::params![
                        file.source,
                        block.position,
                        block.key,
                        ordinal as i64,
                        answer,
                    ])?;
                }
            }
        }
    }
    tx.commit()
}

/// Drop every block that came out of a file, and no others — the way back out of
/// an import of the wrong folder. All at once and deliberately not selective:
/// what you memorized is what would hurt to lose and is what this cannot touch,
/// and the rest can be read again from the files.
fn forget_imports(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute("DELETE FROM answer WHERE source <> ''", [])?;
    tx.execute("DELETE FROM block WHERE source <> ''", [])?;
    tx.commit()
}

#[tauri::command]
pub fn store_import(
    app: tauri::AppHandle,
    dir: String,
    files: Vec<ImportedFile>,
) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Err("no folder to import from".into());
    }
    let path = path(&app)?;
    import(&mut open(&path)?, &dir, &files).map_err(at(&path))
}

#[tauri::command]
pub fn store_forget_imports(app: tauri::AppHandle) -> Result<(), String> {
    let path = path(&app)?;
    forget_imports(&mut open(&path)?).map_err(at(&path))
}

#[cfg(test)]
mod tests {
    use super::{
        blocks, config_in, forget_imports, import, memorize, open, read_config, rename_position,
        steps_of, store_in, Imported, ImportedFile, MIGRATIONS,
    };

    /// A store of our own, named after the test using it.
    fn scratch(name: &str) -> rusqlite::Connection {
        let path = std::env::temp_dir().join(format!("flow-store-{name}.flow"));
        let _ = std::fs::remove_file(&path);
        open(&path).unwrap()
    }

    /// Both halves, as one list. The store keeps them apart on purpose (see
    /// `blocks`); a test that is about neither wants them together.
    fn all(db: &rusqlite::Connection) -> Vec<super::Block> {
        let mut out = blocks(db, true).unwrap();
        out.extend(blocks(db, false).unwrap());
        out
    }

    /// The answers memorized under a key — the user's own blocks, which is what
    /// every test below this line but the import ones is about.
    fn answers(db: &rusqlite::Connection, position: &str, key: &str) -> Vec<String> {
        from(db, "", position, key)
    }

    fn from(
        db: &rusqlite::Connection,
        source: &str,
        position: &str,
        key: &str,
    ) -> Vec<String> {
        all(db)
            .into_iter()
            .find(|block| {
                block.source == source && block.position == position && block.key == key
            })
            .map(|block| block.answers)
            .unwrap_or_default()
    }

    /// One file's blocks, for the import tests.
    fn file(source: &str, blocks: &[(&str, &str, &[&str])]) -> ImportedFile {
        ImportedFile {
            source: source.into(),
            blocks: blocks
                .iter()
                .map(|(position, key, answers)| Imported {
                    position: (*position).into(),
                    key: (*key).into(),
                    argument: (*key).into(),
                    answers: answers.iter().map(|a| (*a).to_string()).collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn keeps_the_answers_to_an_argument_in_order() {
        let mut db = scratch("order");
        memorize(
            &mut db,
            "Assurance DA",
            "neg flex",
            "neg flex",
            &["perm do both".into(), "dispo solves".into(), "no offense".into()],
        )
        .unwrap();
        assert_eq!(
            answers(&db, "Assurance DA", "neg flex"),
            ["perm do both", "dispo solves", "no offense"]
        );
    }

    #[test]
    fn memorizing_again_replaces_the_block() {
        let mut db = scratch("replace");
        memorize(&mut db, "", "neg flex", "neg flex", &["a".into(), "b".into()]).unwrap();
        memorize(&mut db, "", "neg flex", "Neg Flex", &["c".into()]).unwrap();

        let all = all(&db);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].answers, ["c"]);
        // The argument as last written — the key is what stayed the same.
        assert_eq!(all[0].argument, "Neg Flex");
    }

    #[test]
    fn memorizing_nothing_forgets_the_block() {
        let mut db = scratch("forget");
        memorize(&mut db, "Cap K", "neg flex", "neg flex", &["a".into()]).unwrap();
        memorize(&mut db, "Cap K", "neg flex", "neg flex", &[]).unwrap();
        assert!(all(&db).is_empty());
        // And takes the answers with it rather than orphaning them.
        let left: i64 = db
            .query_row("SELECT count(*) FROM answer", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn forgetting_what_was_never_memorized_is_not_a_failure() {
        let mut db = scratch("gone");
        assert!(memorize(&mut db, "", "never", "never", &[]).is_ok());
    }

    /// The whole point of positions: the same argument, answered differently
    /// depending on which position it came up in, is two blocks.
    #[test]
    fn the_same_argument_can_live_in_two_positions() {
        let mut db = scratch("positions");
        memorize(&mut db, "Assurance DA", "no link", "no link", &["it is a plank".into()])
            .unwrap();
        memorize(&mut db, "Politics DA", "no link", "no link", &["winners win".into()])
            .unwrap();

        assert_eq!(all(&db).len(), 2);
        assert_eq!(answers(&db, "Assurance DA", "no link"), ["it is a plank"]);
        assert_eq!(answers(&db, "Politics DA", "no link"), ["winners win"]);

        // And forgetting one leaves the other alone.
        memorize(&mut db, "Politics DA", "no link", "no link", &[]).unwrap();
        assert_eq!(answers(&db, "Assurance DA", "no link"), ["it is a plank"]);
    }

    /// Renaming a position is how a block moves between them — the sheet it
    /// was memorized on turning out to be called something else.
    #[test]
    fn renaming_a_position_carries_its_blocks() {
        let mut db = scratch("rename");
        memorize(&mut db, "DA", "no link", "no link", &["it is a plank".into()]).unwrap();
        memorize(&mut db, "DA", "turn", "turn", &["no impact".into()]).unwrap();
        // Already in the destination, answering something else: it stays.
        memorize(&mut db, "Assurance DA", "perm", "perm", &["do both".into()]).unwrap();

        rename_position(&mut db, "DA", "Assurance DA").unwrap();

        assert_eq!(answers(&db, "Assurance DA", "no link"), ["it is a plank"]);
        assert_eq!(answers(&db, "Assurance DA", "turn"), ["no impact"]);
        assert_eq!(answers(&db, "Assurance DA", "perm"), ["do both"]);
        assert!(all(&db).iter().all(|b| b.position == "Assurance DA"));
    }

    /// The destination wins nothing it didn't ask for: a block carried in
    /// replaces the one already answering that argument there.
    #[test]
    fn renaming_replaces_a_clash_in_the_destination() {
        let mut db = scratch("clash");
        memorize(&mut db, "DA", "no link", "no link", &["the new one".into()]).unwrap();
        memorize(&mut db, "Assurance DA", "no link", "no link", &["the old one".into()])
            .unwrap();

        rename_position(&mut db, "DA", "Assurance DA").unwrap();

        assert_eq!(all(&db).len(), 1);
        assert_eq!(answers(&db, "Assurance DA", "no link"), ["the new one"]);
    }

    /// The whole reason blocks carry a source: what you memorized and what came
    /// out of somebody's file live in the same store and neither writes the
    /// other's rows.
    #[test]
    fn importing_leaves_what_was_memorized_alone() {
        let mut db = scratch("import-mine");
        memorize(&mut db, "Cap K", "alt solves", "alt solves", &["no it doesn't".into()])
            .unwrap();

        import(
            &mut db,
            "/backfiles",
            &[file(
                "/backfiles/cap.cmir",
                &[("Cap K", "alt solves", &["the alt is a utopia"])],
            )],
        )
        .unwrap();

        // The same argument in the same position, twice — once as each.
        assert_eq!(answers(&db, "Cap K", "alt solves"), ["no it doesn't"]);
        assert_eq!(
            from(&db, "/backfiles/cap.cmir", "Cap K", "alt solves"),
            ["the alt is a utopia"]
        );

        // And the memory sheet's own writes still can't reach the file's blocks.
        memorize(&mut db, "Cap K", "alt solves", "alt solves", &[]).unwrap();
        assert_eq!(
            from(&db, "/backfiles/cap.cmir", "Cap K", "alt solves"),
            ["the alt is a utopia"]
        );
        rename_position(&mut db, "Cap K", "The K").unwrap();
        assert_eq!(
            from(&db, "/backfiles/cap.cmir", "Cap K", "alt solves"),
            ["the alt is a utopia"]
        );
    }

    /// Reading a folder again is what the folder says now, including about the
    /// files that have gone.
    #[test]
    fn importing_a_folder_again_replaces_it_whole() {
        let mut db = scratch("import-again");
        import(
            &mut db,
            "/backfiles",
            &[
                file("/backfiles/da.cmir", &[("Politics", "no link", &["it is a plank"])]),
                file("/backfiles/cp.cmir", &[("Court Clog", "solvency", &["it solves"])]),
            ],
        )
        .unwrap();
        assert_eq!(all(&db).len(), 2);

        // `cp.cmir` has since been deleted, and `da.cmir` says something else.
        import(
            &mut db,
            "/backfiles",
            &[file("/backfiles/da.cmir", &[("Politics", "no link", &["winners win"])])],
        )
        .unwrap();

        let all = all(&db);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].answers, ["winners win"]);
    }

    /// One folder's import is not another's.
    #[test]
    fn importing_one_folder_leaves_another_alone() {
        let mut db = scratch("import-folders");
        import(
            &mut db,
            "/backfiles/da",
            &[file("/backfiles/da/politics.cmir", &[("Politics", "no link", &["a"])])],
        )
        .unwrap();
        // A prefix of the first, and a sibling of it: neither may be swept up.
        import(
            &mut db,
            "/backfiles/das",
            &[file("/backfiles/das/other.cmir", &[("Other", "turn", &["b"])])],
        )
        .unwrap();

        assert_eq!(all(&db).len(), 2);
        assert_eq!(from(&db, "/backfiles/da/politics.cmir", "Politics", "no link"), ["a"]);
    }

    #[test]
    fn forgetting_the_imports_keeps_what_was_memorized() {
        let mut db = scratch("import-forget");
        memorize(&mut db, "", "neg flex", "neg flex", &["dispo solves".into()]).unwrap();
        import(
            &mut db,
            "/backfiles",
            &[file("/backfiles/da.cmir", &[("Politics", "no link", &["it is a plank"])])],
        )
        .unwrap();

        forget_imports(&mut db).unwrap();

        let all = all(&db);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].source, "");
        assert_eq!(all[0].answers, ["dispo solves"]);
        let orphans: i64 = db
            .query_row("SELECT count(*) FROM answer WHERE source <> ''", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(orphans, 0);
    }

    /// A block with nothing under it means "forget this one" when `m` says it,
    /// and means nothing at all coming out of a file — there is no block there
    /// to forget. Dropped on the way in rather than written as an empty one.
    #[test]
    fn an_imported_block_with_no_answers_is_skipped() {
        let mut db = scratch("import-empty");
        import(
            &mut db,
            "/backfiles",
            &[file(
                "/backfiles/da.cmir",
                &[("Politics", "no link", &[]), ("Politics", "turn", &["no impact"])],
            )],
        )
        .unwrap();
        assert_eq!(all(&db).len(), 1);
    }

    /// A home directory of our own, for the tests about where the store lives.
    fn home(name: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("flow-home-{name}"));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    /// A store at `path` with one block in it.
    fn seed(path: &std::path::Path) {
        let mut db = open(path).unwrap();
        memorize(&mut db, "Cap K", "alt solves", "alt solves", &["no it doesn't".into()])
            .unwrap();
    }

    #[test]
    fn makes_the_directory_on_a_machine_that_has_never_run_it() {
        let home = home("fresh");
        let store = store_in(&home).unwrap();

        assert_eq!(store, home.join(".flow").join("db"));
        assert!(home.join(".flow").is_dir());
        // And nothing is claimed to be there that isn't: the file itself is the
        // database's to make, on the first open.
        assert!(!store.exists());
    }

    #[test]
    fn settings_sit_beside_the_database() {
        let home = home("settings");
        let config = config_in(&home).unwrap();

        assert_eq!(config, home.join(".flow").join("config.json"));
        // No file yet is the ordinary case, not an error: the app ships
        // without one and reads its own defaults.
        assert_eq!(read_config(&config).unwrap(), None);

        std::fs::write(&config, r#"{"keys":{"g":"answer"}}"#).unwrap();
        assert_eq!(
            read_config(&config).unwrap().as_deref(),
            Some(r#"{"keys":{"g":"answer"}}"#)
        );
    }

    /// Every launch after the first runs this too, and it must be a no-op.
    #[test]
    fn finds_the_same_store_every_launch() {
        let home = home("settled");
        let store = store_in(&home).unwrap();
        seed(&store);

        assert_eq!(store_in(&home).unwrap(), store);
        assert_eq!(answers(&open(&store).unwrap(), "Cap K", "alt solves"), ["no it doesn't"]);
    }

    /// The runner over a list longer than the real one: each step runs once,
    /// in order, and a second pass over the same file runs none of them again.
    ///
    /// `MIGRATIONS` is one step, so running it proves almost nothing about
    /// running a list. This is what will matter the first time a step is
    /// appended after ship — the version has to land on the count of steps
    /// applied, or the next launch re-runs a `CREATE TABLE` against a store
    /// with somebody's blocks in it.
    #[test]
    fn runs_each_migration_once_and_in_order() {
        let path = std::env::temp_dir().join("flow-store-steps.flow");
        let _ = std::fs::remove_file(&path);
        let db = rusqlite::Connection::open(&path).unwrap();

        let steps = [
            "CREATE TABLE one (x INTEGER)",
            "CREATE TABLE two (x INTEGER); INSERT INTO one (x) VALUES (1)",
            "INSERT INTO two (x) VALUES (2)",
        ];

        // A file that has had the first step only — the shape of an installed
        // store when a new build arrives.
        steps_of(&db, &steps[..1]).unwrap();
        assert_eq!(version(&db), 1);

        steps_of(&db, &steps).unwrap();
        assert_eq!(version(&db), 3);
        assert_eq!(rows(&db, "one"), 1, "step two ran, and only once");
        assert_eq!(rows(&db, "two"), 1);

        // Already current: nothing runs, and re-running step one would throw.
        steps_of(&db, &steps).unwrap();
        assert_eq!(version(&db), 3);
        assert_eq!(rows(&db, "one"), 1);
        assert_eq!(rows(&db, "two"), 1);
    }

    /// A step that fails takes its version with it, so the next launch tries
    /// the same step again rather than skipping past it onto a schema the file
    /// hasn't got.
    #[test]
    fn a_migration_that_fails_does_not_advance_the_version() {
        let path = std::env::temp_dir().join("flow-store-step-fails.flow");
        let _ = std::fs::remove_file(&path);
        let db = rusqlite::Connection::open(&path).unwrap();

        let steps = ["CREATE TABLE one (x INTEGER)", "THIS IS NOT SQL"];
        assert!(steps_of(&db, &steps).is_err());
        assert_eq!(version(&db), 1);
        assert_eq!(rows(&db, "one"), 0);
    }

    fn version(db: &rusqlite::Connection) -> i64 {
        db.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap()
    }

    fn rows(db: &rusqlite::Connection, table: &str) -> i64 {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn opening_an_existing_store_keeps_what_is_in_it() {
        let path = std::env::temp_dir().join("flow-store-reopen.flow");
        let _ = std::fs::remove_file(&path);

        let mut db = open(&path).unwrap();
        memorize(&mut db, "Cap K", "neg flex", "neg flex", &["dispo solves".into()]).unwrap();
        drop(db);

        // The second open runs no migration — the file is already current — and
        // must not touch what the first one wrote.
        let db = open(&path).unwrap();
        assert_eq!(answers(&db, "Cap K", "neg flex"), ["dispo solves"]);
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

}
