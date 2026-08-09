use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use tauri::Manager;

/// `~/.flow`: what the *user* keeps, as against what a round does.
///
/// A round is a folder the user picked, and it is theirs to copy, hand over and
/// drop into next week's file (see `files.rs`). This is the other half — the
/// things that follow the person from round to round rather than the round from
/// tournament to tournament. Memorized answers now; settings later, which is
/// what the migration list below leaves room for.
///
/// One file, always in the same place, so nothing ever has to ask where it is
/// or offer to go looking.
///
/// What it holds is blocks: an argument, and the answers to it, in order. You
/// have answered neg flex a hundred times and it is the same four answers every
/// time — so the sheet you already flowed them on is where they come from, and
/// the next time the argument shows up they go in as a block.
///
/// Each block also carries the *position* it belongs to — the assurance DA, the
/// cap K — which is nothing more than the title of the sheet it was memorized
/// on. It costs no keystroke and it is what keeps a framework block out of your
/// way while you are answering a disadvantage. A block memorized on a sheet
/// with no title has no position, which is a perfectly good place for a block
/// to be; positions are a filter, not a filing requirement.
///
/// A database rather than another JSON file because this one is written *into*
/// while a round is being flowed. Rewriting a season of blocks to record that
/// one of them changed is how somebody eventually loses the lot; SQLite writes
/// the rows and leaves the rest alone, and it is still a single file, so
/// `.flow` is still something you can copy to another machine.
///
/// Nothing here knows what an argument *means*, or when two of them are the
/// same argument. It stores the lines and hands them back — matching is the
/// frontend's (see `src/memory/recall.ts`), which is why `key` below is a value
/// this is *given* rather than one it works out. The same split `files.rs`
/// keeps with the sheet format.

/// The file, under the user's home directory.
const FILE: &str = ".flow";

/// The schema, one step per version. `PRAGMA user_version` records how many of
/// them a file has had, so a `.flow` written by an older build is brought up to
/// date by running the rest of the list.
///
/// The first step is dead — nothing writes a `memorized` table any more — and
/// stays here because a file that *has* one has to be carried forward from it.
/// A migration list is a history, not a description of the current schema; the
/// current schema is whatever running the whole list leaves you with.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE memorized (
        text         TEXT PRIMARY KEY,
        uses         INTEGER NOT NULL DEFAULT 0,
        memorized_at INTEGER NOT NULL,
        used_at      INTEGER
    )",
    "DROP TABLE memorized;
     CREATE TABLE block (
        key          TEXT PRIMARY KEY,
        argument     TEXT NOT NULL,
        memorized_at INTEGER NOT NULL
     );
     CREATE TABLE answer (
        key      TEXT NOT NULL REFERENCES block (key) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text     TEXT NOT NULL,
        PRIMARY KEY (key, position)
     )",
    // Positions. A rebuild rather than an `ALTER TABLE`, because the key of a
    // block is now the position and the argument together and SQLite cannot
    // change a primary key in place. Everything already memorized keeps its
    // answers and comes through with no position — which is exactly what it
    // had, since there was nowhere to record one.
    //
    // The foreign key goes with it. It bought one cascading delete and cost a
    // pragma that has to be set on every connection and a rule that constrains
    // every future migration; `forget` deletes from two tables instead of one.
    "CREATE TABLE block_v3 (
        position     TEXT NOT NULL,
        key          TEXT NOT NULL,
        argument     TEXT NOT NULL,
        memorized_at INTEGER NOT NULL,
        PRIMARY KEY (position, key)
     );
     CREATE TABLE answer_v3 (
        position TEXT NOT NULL,
        key      TEXT NOT NULL,
        ordinal  INTEGER NOT NULL,
        text     TEXT NOT NULL,
        PRIMARY KEY (position, key, ordinal)
     );
     INSERT INTO block_v3 (position, key, argument, memorized_at)
        SELECT '', key, argument, memorized_at FROM block;
     INSERT INTO answer_v3 (position, key, ordinal, text)
        SELECT '', key, position, text FROM answer;
     DROP TABLE answer;
     DROP TABLE block;
     ALTER TABLE block_v3 RENAME TO block;
     ALTER TABLE answer_v3 RENAME TO answer",
];

/// An argument and the answers to it.
#[derive(Serialize)]
pub struct Block {
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
    let done: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (i, step) in MIGRATIONS.iter().enumerate().skip(done as usize) {
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

/// Where the store lives. Not configurable, and deliberately: a file you have
/// to be told the location of is a file that gets left behind on the old
/// machine.
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map(|home| home.join(FILE))
        .map_err(|e| format!("no home directory: {e}"))
}

/// Everything memorized. The whole lot, in one call and once per launch: it is
/// a few hundred short lines at most, an argument is looked up every time the
/// cursor moves, and nothing about moving the cursor should reach the disk.
fn blocks(db: &Connection) -> rusqlite::Result<Vec<Block>> {
    let mut query = db.prepare(
        "SELECT block.position, block.key, block.argument, answer.text
         FROM block JOIN answer
           ON answer.position = block.position AND answer.key = block.key
         ORDER BY block.position, block.key, answer.ordinal",
    )?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    // One row per answer, gathered back into one entry per block — the join is
    // ordered by position and key, so each block's rows arrive together.
    let mut out: Vec<Block> = Vec::new();
    for row in rows {
        let (position, key, argument, answer) = row?;
        match out.last_mut() {
            Some(block) if block.key == key && block.position == position => {
                block.answers.push(answer)
            }
            _ => out.push(Block {
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
/// *from*: the block you have in front of you is the one you decided is right,
/// and a store that quietly kept the version you had already edited away would
/// give you back answers you have deliberately stopped making.
///
/// No answers forgets the block entirely — an argument with nothing under it is
/// the way you say you no longer want this one.
fn memorize(
    db: &mut Connection,
    position: &str,
    key: &str,
    argument: &str,
    answers: &[String],
) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM answer WHERE position = ?1 AND key = ?2",
        [position, key],
    )?;
    tx.execute(
        "DELETE FROM block WHERE position = ?1 AND key = ?2",
        [position, key],
    )?;
    if !answers.is_empty() {
        tx.execute(
            "INSERT INTO block (position, key, argument, memorized_at)
             VALUES (?1, ?2, ?3, strftime('%s', 'now'))",
            [position, key, argument],
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO answer (position, key, ordinal, text) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (ordinal, answer) in answers.iter().enumerate() {
            insert.execute(rusqlite::params![position, key, ordinal as i64, answer])?;
        }
    }
    tx.commit()
}

#[tauri::command]
pub fn store_blocks(app: tauri::AppHandle) -> Result<Vec<Block>, String> {
    let path = path(&app)?;
    blocks(&open(&path)?).map_err(at(&path))
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
/// A block already under `to` answering the same argument is replaced: two
/// blocks answering one argument in one position is the single thing the key
/// does not allow, and the one being carried in is the one the user just named.
fn rename_position(db: &mut Connection, from: &str, to: &str) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM answer WHERE position = ?1
           AND key IN (SELECT key FROM block WHERE position = ?2)",
        [to, from],
    )?;
    tx.execute(
        "DELETE FROM block WHERE position = ?1
           AND key IN (SELECT key FROM block WHERE position = ?2)",
        [to, from],
    )?;
    tx.execute("UPDATE block SET position = ?1 WHERE position = ?2", [to, from])?;
    tx.execute("UPDATE answer SET position = ?1 WHERE position = ?2", [to, from])?;
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

#[cfg(test)]
mod tests {
    use super::{blocks, memorize, open, rename_position, MIGRATIONS};

    /// A store of our own, named after the test using it.
    fn scratch(name: &str) -> rusqlite::Connection {
        let path = std::env::temp_dir().join(format!("flow-store-{name}.flow"));
        let _ = std::fs::remove_file(&path);
        open(&path).unwrap()
    }

    fn answers(db: &rusqlite::Connection, position: &str, key: &str) -> Vec<String> {
        blocks(db)
            .unwrap()
            .into_iter()
            .find(|block| block.position == position && block.key == key)
            .map(|block| block.answers)
            .unwrap_or_default()
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

        let all = blocks(&db).unwrap();
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
        assert!(blocks(&db).unwrap().is_empty());
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

        assert_eq!(blocks(&db).unwrap().len(), 2);
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
        assert!(blocks(&db).unwrap().iter().all(|b| b.position == "Assurance DA"));
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

        assert_eq!(blocks(&db).unwrap().len(), 1);
        assert_eq!(answers(&db, "Assurance DA", "no link"), ["the new one"]);
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

    /// A file left at each earlier version, brought forward. These are the
    /// files on the disk of anybody who ran an earlier build, and the second
    /// one has blocks in it that must survive the trip.
    #[test]
    fn carries_older_files_forward() {
        for version in 1..MIGRATIONS.len() {
            let path = std::env::temp_dir().join(format!("flow-store-v{version}.flow"));
            let _ = std::fs::remove_file(&path);

            let old = rusqlite::Connection::open(&path).unwrap();
            for (i, step) in MIGRATIONS.iter().enumerate().take(version) {
                old.execute_batch(&format!(
                    "BEGIN; {step}; PRAGMA user_version = {}; COMMIT;",
                    i + 1
                ))
                .unwrap();
            }
            if version == 2 {
                old.execute_batch(
                    "INSERT INTO block (key, argument, memorized_at)
                        VALUES ('neg flex', 'neg flex', 0);
                     INSERT INTO answer (key, position, text)
                        VALUES ('neg flex', 0, 'perm do both'),
                               ('neg flex', 1, 'dispo solves')",
                )
                .unwrap();
            }
            drop(old);

            let mut db = open(&path).unwrap();
            if version == 2 {
                // Carried through with no position, in order — there was
                // nowhere to record one, so it has none.
                assert_eq!(
                    answers(&db, "", "neg flex"),
                    ["perm do both", "dispo solves"],
                    "v{version} lost its blocks"
                );
            }
            memorize(&mut db, "Cap K", "alt solves", "alt solves", &["no it doesn't".into()])
                .unwrap();
            assert_eq!(answers(&db, "Cap K", "alt solves"), ["no it doesn't"]);
        }
    }
}
