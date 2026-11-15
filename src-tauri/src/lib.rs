mod engine;
mod transport;

use engine::{Engine, Peer, Snapshot};
use std::sync::Arc;
use tauri::{Manager, State};

type AppState = Arc<Engine>;

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.snapshot()
}

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.snapshot()
}

#[tauri::command]
fn create_network(name: String, state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.create_network(name)
}

#[tauri::command]
fn join_network(invite: String, state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.join_network(invite)
}

#[tauri::command]
fn create_note(state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.create_note()
}

#[tauri::command]
fn update_note(
    id: String,
    title: String,
    body: String,
    base_heads: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    state.update_note(id, title, body, base_heads)
}

#[tauri::command]
fn delete_note(id: String, state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.delete_note(id)
}

#[tauri::command]
fn peer_discovered(peer: Peer, state: State<'_, AppState>) -> Result<(), String> {
    state.peer_discovered(peer)
}

#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.request_sync()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_lan::init())
        .setup(|app| {
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            let engine = Engine::open(app.path().app_data_dir()?).map_err(std::io::Error::other)?;
            tauri::async_runtime::block_on(transport::start(engine.clone()))
                .map_err(std::io::Error::other)?;
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_snapshot,
            create_network,
            join_network,
            create_note,
            update_note,
            delete_note,
            peer_discovered,
            sync_now
        ])
        .run(tauri::generate_context!())
        .expect("Murmur could not start");
}
