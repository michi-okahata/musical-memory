use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// A round on disk: a directory, and one file per sheet in it.
///
/// The directory is the round because that is what a round already is — a stack
/// of independent positions, each of which you want to be able to hand to
/// somebody, diff, or drop into next week's file on its own. A single archive
/// would make the whole round the smallest thing you can move.
///
/// Nothing here knows what a sheet *is*: the frontend serialises them (see
/// `src/files/format.ts`) and this reads and writes the text. The split is what
/// keeps the format a frontend concern — the same JSON is what a headless peer
/// would write — and leaves this with the two things only the native side can
/// do, which are the folder dialog and touching the disk at all.

/// The extension a sheet is kept in. Everything else in the directory belongs
/// to somebody else and is neither read nor written.
const EXTENSION: &str = "json";

/// One file, as read off disk.
#[derive(Serialize)]
pub struct SheetFile {
    /// The bare file name — `politics-da.json`. Also the handle the frontend
    /// writes and deletes by, because a name is all it is ever given.
    pub name: String,
    pub text: String,
}

/// Turn a file name from the frontend into a path inside `dir`.
///
/// A name is all it may pass: a separator or a `..` would let a slip in the
/// sheet-naming code write anywhere on the disk, and the frontend has no reason
/// to name anything but a file in the directory the user picked. Rejected
/// rather than sanitised — a name that needed sanitising is one that should
/// never have been produced, and quietly rewriting it would hide the bug.
fn resolve(dir: &str, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    let plain = !name.is_empty()
        && !name.contains(['/', '\\'])
        && path.components().count() == 1
        && path.file_name().map(|n| n == name).unwrap_or(false);
    if !plain {
        return Err(format!("not a file name: {name}"));
    }
    if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
        return Err(format!("not a sheet: {name}"));
    }
    Ok(Path::new(dir).join(name))
}

/// Ask for a directory. `None` when the dialog was dismissed.
///
/// Async so that the blocking dialog runs on the async runtime rather than on
/// the main thread — the plugin dispatches the window to the main thread itself,
/// and blocking it from here would deadlock against that.
#[tauri::command]
pub async fn files_pick_directory(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Every sheet file in `dir`, by name, sorted so a round opens the same way
/// twice. The order the sheets are actually *read* in is the frontend's (each
/// file carries its own place in the round); this order only settles ties.
///
/// A file that can't be read as text is skipped rather than failing the whole
/// directory: one stray binary should not be able to stop a round from opening.
#[tauri::command]
pub fn files_read_dir(dir: String) -> Result<Vec<SheetFile>, String> {
    let mut sheets = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("{dir}: {e}"))? {
        let path = entry.map_err(|e| format!("{dir}: {e}"))?.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        sheets.push(SheetFile {
            name: name.to_string(),
            text,
        });
    }
    sheets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(sheets)
}

/// Write one sheet, creating the directory if the user picked one that has
/// since gone.
#[tauri::command]
pub fn files_write(dir: String, name: String, text: String) -> Result<(), String> {
    let path = resolve(&dir, &name)?;
    fs::create_dir_all(&dir).map_err(|e| format!("{dir}: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Delete one sheet. Already gone is the outcome that was wanted, so it is not
/// an error — the frontend deletes a file after a rename has written the new
/// one, and a round opened twice would otherwise report the second pass.
#[tauri::command]
pub fn files_remove(dir: String, name: String) -> Result<(), String> {
    let path = resolve(&dir, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::{files_read_dir, files_remove, files_write, resolve};

    /// A directory of our own to write in, named after the test using it.
    fn scratch(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("flow-files-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn writes_reads_and_removes_a_round() {
        let dir = scratch("round");

        files_write(dir.clone(), "case.json".into(), "{\"flow\":1}".into()).unwrap();
        files_write(dir.clone(), "politics-da.json".into(), "{\"flow\":1,\"order\":1}".into())
            .unwrap();
        // Not a sheet, and not ours: it must survive everything below.
        std::fs::write(std::path::Path::new(&dir).join("notes.txt"), "mine").unwrap();

        let read = files_read_dir(dir.clone()).unwrap();
        let names: Vec<_> = read.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["case.json", "politics-da.json"]);
        assert_eq!(read[0].text, "{\"flow\":1}");

        files_remove(dir.clone(), "case.json".into()).unwrap();
        let left: Vec<_> = files_read_dir(dir.clone())
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(left, ["politics-da.json"]);
        assert!(std::path::Path::new(&dir).join("notes.txt").exists());
    }

    #[test]
    fn removing_what_is_not_there_is_not_a_failure() {
        let dir = scratch("gone");
        assert!(files_remove(dir, "never-existed.json".into()).is_ok());
    }

    #[test]
    fn writes_into_a_directory_that_has_since_gone() {
        let dir = scratch("recreate");
        std::fs::remove_dir_all(&dir).unwrap();
        files_write(dir.clone(), "case.json".into(), "{\"flow\":1}".into()).unwrap();
        assert_eq!(files_read_dir(dir).unwrap().len(), 1);
    }

    #[test]
    fn refuses_to_write_outside_the_directory() {
        let dir = scratch("escape");
        let outside = std::env::temp_dir().join("flow-escaped.json");
        let _ = std::fs::remove_file(&outside);

        assert!(files_write(dir.clone(), "../flow-escaped.json".into(), "x".into()).is_err());
        assert!(files_remove(dir, "../flow-escaped.json".into()).is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn resolves_a_plain_sheet_name() {
        assert_eq!(
            resolve("/rounds/octas", "politics-da.json").unwrap(),
            std::path::Path::new("/rounds/octas/politics-da.json")
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_bare_name() {
        for name in ["../secrets.json", "a/b.json", "/etc/hosts.json", "", ".."] {
            assert!(resolve("/rounds", name).is_err(), "accepted {name}");
        }
    }

    #[test]
    fn refuses_a_file_that_is_not_a_sheet() {
        assert!(resolve("/rounds", "notes.txt").is_err());
        assert!(resolve("/rounds", "notes").is_err());
    }
}
