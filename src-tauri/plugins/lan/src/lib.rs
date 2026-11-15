use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use desktop::Lan;
#[cfg(any(target_os = "android", target_os = "ios"))]
use mobile::Lan;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub service_name: String,
    pub port: u16,
    pub network_id: String,
    pub device_id: String,
}

impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.port == 0 || self.service_name.is_empty() || self.service_name.len() > 63 {
            return Err("Invalid LAN service name or port".into());
        }
        for value in [&self.network_id, &self.device_id] {
            if value.is_empty()
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            {
                return Err("Invalid LAN network or device ID".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device_id: String,
    pub network_id: String,
    pub addresses: Vec<String>,
    pub port: u16,
}

#[tauri::command]
async fn start<R: Runtime>(app: tauri::AppHandle<R>, config: Config) -> Result<(), String> {
    config.validate()?;
    app.state::<Lan<R>>().start(config)
}

#[tauri::command]
async fn stop<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    app.state::<Lan<R>>().stop()
}

#[tauri::command]
fn is_mobile() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lan")
        .invoke_handler(tauri::generate_handler![start, stop, is_mobile])
        .setup(|app, api| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let lan = mobile::init(app, api)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let lan = {
                let _ = api;
                desktop::Lan::new(app.clone())
            };
            app.manage(lan);
            Ok(())
        })
        .build()
}
