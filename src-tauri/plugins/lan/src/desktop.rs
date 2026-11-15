use crate::{Config, Peer};
use mdns_sd::{DaemonEvent, ScopedIp, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

const SERVICE_TYPE: &str = "_murmur._tcp.local.";

struct Running {
    config: Config,
    daemon: ServiceDaemon,
    live: Arc<AtomicBool>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.live.store(false, Ordering::Relaxed);
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        let _ = self.daemon.shutdown();
    }
}

pub struct Lan<R: Runtime> {
    app: AppHandle<R>,
    running: Mutex<Option<Running>>,
}

impl<R: Runtime> Lan<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            running: Mutex::new(None),
        }
    }

    pub fn start(&self, config: Config) -> Result<(), String> {
        let mut running = self.running.lock().map_err(|e| e.to_string())?;
        if running.as_ref().is_some_and(|r| r.config == config) {
            return Ok(());
        }
        running.take();
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let live = Arc::new(AtomicBool::new(true));
        let session = Running {
            config: config.clone(),
            daemon,
            live: live.clone(),
        };
        let hostname = format!("murmur-{}.local.", config.device_id);
        let properties = [
            ("network", config.network_id.as_str()),
            ("device", config.device_id.as_str()),
            ("v", "1"),
        ];
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &config.service_name,
            &hostname,
            "",
            config.port,
            &properties[..],
        )
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
        session
            .daemon
            .register(service)
            .map_err(|e| e.to_string())?;
        let events = session
            .daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| e.to_string())?;
        let monitor = session.daemon.monitor().map_err(|e| e.to_string())?;
        let app = self.app.clone();
        std::thread::Builder::new()
            .name("murmur-discovery".into())
            .spawn(move || {
                while live.load(Ordering::Relaxed) {
                    while let Ok(event) = monitor.try_recv() {
                        if let DaemonEvent::Error(error) = event {
                            let _ = app.emit(
                                "lan-error",
                                serde_json::json!({"message": error.to_string()}),
                            );
                        }
                    }
                    if let Ok(ServiceEvent::ServiceResolved(info)) =
                        events.recv_timeout(Duration::from_millis(500))
                    {
                        let network_id = info.get_property_val_str("network").unwrap_or_default();
                        let device_id = info.get_property_val_str("device").unwrap_or_default();
                        if network_id != config.network_id
                            || device_id.is_empty()
                            || device_id == config.device_id
                        {
                            continue;
                        }
                        let addresses = info
                            .get_addresses()
                            .iter()
                            .map(|address| match address {
                                ScopedIp::V6(v6)
                                    if v6.addr().is_unicast_link_local()
                                        && v6.scope_id().index != 0 =>
                                {
                                    format!("{}%{}", v6.addr(), v6.scope_id().index)
                                }
                                _ => address.to_ip_addr().to_string(),
                            })
                            .collect();
                        let _ = app.emit(
                            "lan-peer",
                            Peer {
                                device_id: device_id.into(),
                                network_id: network_id.into(),
                                addresses,
                                port: info.get_port(),
                            },
                        );
                    }
                    if events.is_disconnected() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        *running = Some(session);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.running.lock().map_err(|e| e.to_string())?.take();
        Ok(())
    }
}
