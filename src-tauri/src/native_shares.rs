use crate::{engine::Engine, incoming};
#[cfg(not(target_os = "ios"))]
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
static INBOX_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager,
    };
    struct Inbox(PluginHandle<tauri::Wry>);
    #[derive(serde::Deserialize)]
    struct Location {
        path: String,
    }
    pub fn init() -> TauriPlugin<tauri::Wry> {
        Builder::new("share-inbox")
            .setup(|app, api| {
                app.manage(Inbox(
                    api.register_android_plugin("app.murmur.notes", "ShareInboxPlugin")?,
                ));
                Ok(())
            })
            .build()
    }
    pub async fn source(app: &AppHandle) -> Result<Option<PathBuf>, String> {
        let inbox = app
            .try_state::<Inbox>()
            .ok_or("The native share inbox is unavailable")?;
        let location: Location = inbox
            .0
            .run_mobile_plugin_async("getInboxPath", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())?;
        Ok(Some(PathBuf::from(location.path)))
    }

    pub async fn read_clipboard(app: &AppHandle) -> Result<crate::files::FileContent, String> {
        let inbox = app
            .try_state::<Inbox>()
            .ok_or("The clipboard is unavailable")?;
        inbox
            .0
            .run_mobile_plugin_async("readClipboardImage", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn write_clipboard(app: &AppHandle, data: String) -> Result<(), String> {
        let inbox = app
            .try_state::<Inbox>()
            .ok_or("The clipboard is unavailable")?;
        inbox
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "writeClipboardImage",
                serde_json::json!({ "dataBase64": data }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}
#[cfg(target_os = "android")]
pub use android::init;
#[cfg(target_os = "android")]
pub use android::{read_clipboard, write_clipboard};

pub async fn refresh(app: &AppHandle, engine: Arc<Engine>) -> Result<(), String> {
    let _guard = INBOX_LOCK.lock().await;
    #[cfg(target_os = "android")]
    let source = android::source(app).await?;
    #[cfg(target_os = "ios")]
    let source = crate::apple_shares::source_database(app).await?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let source: Option<PathBuf> = {
        let _ = app;
        None
    };
    if let Some(path) = source {
        tauri::async_runtime::spawn_blocking(move || {
            incoming::receive_database(&engine, &path, false)
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub async fn receive_macos(
    app: AppHandle,
    engine: Arc<Engine>,
    urls: Vec<tauri::Url>,
) -> Result<(), String> {
    use tauri::Emitter;
    let _guard = INBOX_LOCK.lock().await;
    if urls.len() > 32 {
        return Err("Too many incoming shares.".into());
    }
    for url in urls {
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        if path.extension().and_then(|ext| ext.to_str()) != Some("murmur-share") {
            continue;
        }
        let engine = Arc::clone(&engine);
        tauri::async_runtime::spawn_blocking(move || {
            incoming::receive_database(&engine, &path, true)
        })
        .await
        .map_err(|error| error.to_string())??;
        app.emit("share_received", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
