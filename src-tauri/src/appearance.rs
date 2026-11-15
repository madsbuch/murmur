use crate::engine::Theme;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

struct Appearance<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("appearance")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.murmur.notes", "AppearancePlugin")?;
            app.manage(Appearance(handle));
            Ok(())
        })
        .build()
}

pub async fn apply<R: Runtime>(
    app: &AppHandle<R>,
    theme: Theme,
    initial: bool,
) -> Result<(), String> {
    let appearance = app
        .try_state::<Appearance<R>>()
        .ok_or("The native appearance bridge is unavailable")?;
    appearance
        .0
        .run_mobile_plugin_async::<serde_json::Value>(
            "apply",
            serde_json::json!({ "theme": theme, "initial": initial }),
        )
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}
