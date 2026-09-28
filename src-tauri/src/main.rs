#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;

use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

#[derive(Clone, Serialize)]
pub(crate) struct Session {
    pub(crate) port: u16,
    pub(crate) token: String,
}

struct Backend {
    session: Mutex<Option<Session>>,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn backend_session(window: tauri::WebviewWindow, backend: tauri::State<'_, Backend>) -> Option<Session> {
    if window.label() != "main" { return None; }
    backend.session.lock().ok()?.clone()
}

#[tauri::command]
async fn start_gog_login(window: tauri::WebviewWindow, app: tauri::AppHandle, backend: tauri::State<'_, Backend>, login_url: String) -> Result<(), String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    let session = backend.session.lock().unwrap().clone().ok_or("Backend unavailable")?;
    auth::start(app, session, login_url)
}

#[tauri::command]
async fn cancel_gog_login(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    auth::cancel(&app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskCapacity {
    total_bytes: u64,
    free_bytes: u64,
    available_bytes: u64,
}

#[tauri::command]
async fn disk_capacity(window: tauri::WebviewWindow, path: String) -> Result<DiskCapacity, String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    let folder = std::path::Path::new(&path);
    if !folder.is_dir() { return Err("Vault location is unavailable".into()); }
    let total_bytes = fs2::total_space(folder).map_err(|_| "Drive or share capacity unavailable")?;
    let free_bytes = fs2::free_space(folder).map_err(|_| "Drive or share capacity unavailable")?;
    let available_bytes = fs2::available_space(folder).map_err(|_| "Drive or share capacity unavailable")?;
    if total_bytes == 0 || free_bytes > total_bytes || available_bytes > free_bytes {
        return Err("Drive or share capacity unavailable".into());
    }
    Ok(DiskCapacity { total_bytes, free_bytes, available_bytes })
}

fn stop_backend(session: &Session) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], session.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!("POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", session.token);
    if stream.write_all(request.as_bytes()).is_err() { return false; }
    let mut response = [0u8; 128];
    matches!(stream.read(&mut response), Ok(size) if response[..size].starts_with(b"HTTP/1.1 200") || response[..size].starts_with(b"HTTP/1.0 200"))
}

fn main() {
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Backend { session: Mutex::new(None), child: Mutex::new(None) })
        .manage(auth::AuthState::new())
        .invoke_handler(tauri::generate_handler![backend_session, start_gog_login, cancel_gog_login, disk_capacity])
        .setup(move |app| {
            let show = MenuItem::with_id(app, "show", "Show GOG Vault", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GOG Vault")
                .menu(&menu)
                .on_menu_event(|handle, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => handle.exit(0),
                    _ => {}
                })
                .build(app)?;
            let legacy_dir = app.path().app_data_dir()?;
            let local_dir = app.path().app_local_data_dir()?;
            let data_dir = if local_dir.join("vault.sqlite").exists() || !legacy_dir.join("vault.sqlite").exists() {
                local_dir
            } else {
                legacy_dir
            };
            std::fs::create_dir_all(&data_dir)?;
            let command = app.shell().sidecar("gog-vault-sidecar")?
                .env("GOG_VAULT_SESSION_TOKEN", &token)
                .env("GOG_VAULT_DATA_DIR", data_dir.to_string_lossy().as_ref())
                .env("GOG_VAULT_DEV", if cfg!(debug_assertions) { "1" } else { "0" });
            let (mut events, child) = command.spawn()?;
            app.state::<Backend>().child.lock().unwrap().replace(child);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) {
                                if value.get("ready").and_then(|ready| ready.as_bool()) == Some(true) {
                                    if let Some(port) = value.get("port").and_then(|port| port.as_u64()).and_then(|port| u16::try_from(port).ok()) {
                                        handle.state::<Backend>().session.lock().unwrap().replace(Session { port, token: token.clone() });
                                    }
                                }
                                if value.get("event").and_then(|event| event.as_str()) == Some("download_complete") {
                                    if let Some(title) = value.get("title").and_then(|title| title.as_str()) {
                                        let _ = handle.notification().builder().title("Archive verified").body(title).show();
                                    }
                                }
                            }
                        }
                        CommandEvent::Terminated(_) => {
                            handle.state::<Backend>().session.lock().unwrap().take();
                            break;
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "gog-auth" && matches!(event, WindowEvent::Destroyed) {
                auth::window_closed(&window.app_handle());
            }
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not start GOG Vault");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let _ = auth::cancel(app);
            let backend = app.state::<Backend>();
            let graceful = backend.session.lock().unwrap().as_ref().is_some_and(stop_backend);
            let child = backend.child.lock().unwrap().take();
            if let Some(child) = child {
                if !graceful { let _ = child.kill(); }
            }
        }
    });
}