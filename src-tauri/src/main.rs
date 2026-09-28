#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

#[derive(Clone, Serialize)]
struct Session {
    port: u16,
    token: String,
}

struct Backend {
    session: Mutex<Option<Session>>,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn backend_session(backend: tauri::State<'_, Backend>) -> Option<Session> {
    backend.session.lock().ok()?.clone()
}

fn main() {
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Backend { session: Mutex::new(None), child: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![backend_session])
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
            let data_dir = app.path().app_data_dir()?;
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not start GOG Vault");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = app.state::<Backend>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}