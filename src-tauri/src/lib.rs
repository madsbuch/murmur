#[cfg(target_os = "android")]
mod appearance;
#[cfg(target_os = "ios")]
mod apple_shares;
mod engine;
mod files;
mod incoming;
mod invitations;
mod native_shares;
mod schema;
mod storage;
mod transport;

use engine::{DraftBackup, Engine, FileContent, Peer, PendingShare, Settings, Snapshot, Theme};
use std::sync::Arc;
use tauri::{Manager, State};

type AppState = Arc<Engine>;

#[tauri::command]
async fn get_pending_shares(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<PendingShare>, String> {
    let intake = native_shares::refresh(&app, Arc::clone(state.inner())).await;
    let pending = state.pending_shares()?;
    if pending.is_empty() {
        intake?;
    }
    // A full native handoff must not hide the existing main inbox: users need
    // its Import/Discard controls to make room before intake can retry.
    Ok(pending)
}

#[tauri::command]
async fn import_pending_shares(
    network_id: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let engine = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || engine.import_pending_shares(network_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn discard_pending_shares(state: State<'_, AppState>) -> Result<(), String> {
    let engine = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || engine.discard_pending_shares())
        .await
        .map_err(|error| error.to_string())?
}

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
async fn import_file(
    network_id: String,
    name: String,
    mime_type: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let engine = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        engine.import_file(network_id, name, mime_type, data_base64)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_file(
    network_id: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<FileContent, String> {
    let engine = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || engine.read_file(network_id, id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_file(
    network_id: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let engine = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || engine.delete_file(network_id, id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state.get_settings()
}

#[tauri::command]
async fn set_theme(
    theme: Theme,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    let settings = state.set_theme(theme)?;
    #[cfg(desktop)]
    app.set_theme(native_theme(settings.theme));
    #[cfg(target_os = "android")]
    appearance::apply(&app, settings.theme, false).await?;
    #[cfg(target_os = "ios")]
    let _ = app;
    Ok(settings)
}

#[cfg(desktop)]
fn native_theme(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

#[tauri::command]
fn get_draft(state: State<'_, AppState>) -> Result<Option<DraftBackup>, String> {
    state.get_draft()
}

#[tauri::command]
fn save_draft(draft: DraftBackup, state: State<'_, AppState>) -> Result<(), String> {
    state.save_draft(draft)
}

#[tauri::command]
fn import_draft(draft: DraftBackup, state: State<'_, AppState>) -> Result<(), String> {
    state.import_draft(draft)
}

#[tauri::command]
fn clear_draft(network_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_draft(network_id, id)
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
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_lan::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            app.handle().plugin(appearance::init())?;
            #[cfg(target_os = "android")]
            app.handle().plugin(native_shares::init())?;
            #[cfg(target_os = "ios")]
            app.handle().plugin(apple_shares::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            let engine = Engine::open(app.path().app_data_dir()?).map_err(std::io::Error::other)?;
            #[cfg(desktop)]
            app.handle().set_theme(native_theme(
                engine.get_settings().map_err(std::io::Error::other)?.theme,
            ));
            #[cfg(target_os = "android")]
            {
                let theme = engine.get_settings().map_err(std::io::Error::other)?.theme;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = appearance::apply(&handle, theme, true).await {
                        eprintln!("Could not apply Android appearance: {error}");
                    }
                });
            }
            tauri::async_runtime::block_on(transport::start(engine.clone()))
                .map_err(std::io::Error::other)?;
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_pending_shares,
            import_pending_shares,
            discard_pending_shares,
            get_snapshot,
            create_network,
            join_network,
            create_note,
            update_note,
            delete_note,
            import_file,
            read_file,
            delete_file,
            get_settings,
            set_theme,
            get_draft,
            save_draft,
            import_draft,
            clear_draft,
            peer_discovered,
            sync_now
        ])
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(state) = handle.try_state::<AppState>() {
                    let engine = Arc::clone(state.inner());
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = native_shares::receive_macos(handle, engine, urls).await
                        {
                            eprintln!("Could not receive shared files: {error}");
                        }
                    });
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (handle, event);
        }),
        Err(error) => {
            eprintln!("Murmur could not start: {error}");
            std::process::exit(1);
        }
    }
}
