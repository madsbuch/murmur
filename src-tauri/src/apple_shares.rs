use std::path::PathBuf;

use serde::Deserialize;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_share_inbox);

struct ShareInbox<R: Runtime>(PluginHandle<R>);

#[derive(Deserialize)]
struct InboxPath {
    path: Option<PathBuf>,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("share-inbox")
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_share_inbox)?;
            app.manage(ShareInbox(handle));
            Ok(())
        })
        .build()
}

pub async fn source_database<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let inbox = app
        .try_state::<ShareInbox<R>>()
        .ok_or("The native share inbox is unavailable")?;
    inbox
        .0
        .run_mobile_plugin_async::<InboxPath>("sourceDatabase", ())
        .await
        .map(|result| result.path)
        .map_err(|error| error.to_string())
}

pub async fn read_clipboard<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<crate::files::FileContent, String> {
    let inbox = app
        .try_state::<ShareInbox<R>>()
        .ok_or("The clipboard is unavailable")?;
    inbox
        .0
        .run_mobile_plugin_async("readClipboardImage", ())
        .await
        .map_err(|error| error.to_string())
}

pub async fn write_clipboard<R: Runtime>(app: &AppHandle<R>, data: String) -> Result<(), String> {
    let inbox = app
        .try_state::<ShareInbox<R>>()
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
