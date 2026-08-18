pub mod cmir;
pub mod files;
pub mod relay;
pub mod store;

use tauri::Manager;

/// Start hosting a relay in this app, and report where peers can reach it.
///
/// Idempotent: asking twice gives back the relay you already have, because the
/// frontend calls this whenever it wants to be sure hosting is on and should
/// not have to keep track of whether it already asked.
#[tauri::command]
async fn relay_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, relay::RelayState>,
    port: Option<u16>,
) -> Result<relay::RelayInfo, String> {
    if let Some(running) = state.0.lock().unwrap().as_ref() {
        return Ok(running.info.clone());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("rooms");

    let running = relay::start(port.unwrap_or(relay::DEFAULT_PORT), dir).await?;
    let info = running.info.clone();
    // Another call could have won the race between the check above and here.
    // Whoever is already in the slot stays, and ours shuts itself down as it
    // drops at the end of this scope.
    let mut slot = state.0.lock().unwrap();
    match slot.as_ref() {
        Some(existing) => Ok(existing.info.clone()),
        None => {
            slot.replace(running);
            Ok(info)
        }
    }
}

/// Stop hosting. Rooms are written out on the way down — see `RunningRelay`.
#[tauri::command]
fn relay_stop(state: tauri::State<'_, relay::RelayState>) {
    state.0.lock().unwrap().take();
}

/// Where this app is hosting, or null if it isn't.
#[tauri::command]
fn relay_info(state: tauri::State<'_, relay::RelayState>) -> Option<relay::RelayInfo> {
    state.0.lock().unwrap().as_ref().map(|r| r.info.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(relay::RelayState::default())
        .invoke_handler(tauri::generate_handler![
            relay_start,
            relay_stop,
            relay_info,
            files::files_pick_directory,
            files::files_read_dir,
            files::files_write,
            files::files_remove,
            store::store_config,
            store::store_seed_config,
            store::store_memorized,
            store::store_imported,
            store::store_memorize,
            store::store_rename_position,
            store::store_import,
            store::store_forget_imports,
            cmir::cmir_read_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
