use rand::{rngs::OsRng, RngCore};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{webview::{NewWindowFeatures, NewWindowResponse}, AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::Session;

const AUTH_WINDOW: &str = "gog-auth";
const LIFETIME: Duration = Duration::from_secs(600);

struct Attempt {
    id: String,
    started: Instant,
    exchanging: bool,
    popups: usize,
}

pub struct AuthState(Mutex<Option<Attempt>>);

impl AuthState {
    pub fn new() -> Self { Self(Mutex::new(None)) }
}

fn callback(url: &Url) -> Result<Option<String>, &'static str> {
    if url.scheme() != "https" || url.host_str() != Some("embed.gog.com") || url.port_or_known_default() != Some(443) || url.path() != "/on_login_success" {
        return Ok(None);
    }
    if !url.username().is_empty() || url.password().is_some() || url.query_pairs().find(|(key, _)| key == "origin").as_ref().map(|(_, value)| value.as_ref()) != Some("client") {
        return Err("GOG returned an invalid login callback");
    }
    let code = url.query_pairs().find(|(key, _)| key == "code").map(|(_, value)| value.into_owned()).ok_or("GOG callback is missing an authorization code")?;
    if code.len() < 12 || code.len() > 512 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("GOG returned an invalid authorization code");
    }
    Ok(Some(code))
}

fn send_code(session: &Session, code: &str) -> Result<(), &'static str> {
    let address = SocketAddr::from(([127, 0, 0, 1], session.port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|_| "GOG Vault backend is unavailable")?;
    stream.set_read_timeout(Some(Duration::from_secs(75))).map_err(|_| "GOG Vault backend is unavailable")?;
    let body = serde_json::json!({ "code": code }).to_string();
    let request = format!("POST /api/gog/auth HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", session.token, body.len());
    stream.write_all(request.as_bytes()).and_then(|_| stream.write_all(body.as_bytes())).map_err(|_| "Could not submit GOG login")?;
    let mut response = [0u8; 128];
    match stream.read(&mut response) {
        Ok(size) if response[..size].starts_with(b"HTTP/1.1 200") || response[..size].starts_with(b"HTTP/1.0 200") => Ok(()),
        _ => Err("GOG sign-in could not be completed. Please try again."),
    }
}

fn close_popups(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("gog-auth-popup-") { let _ = window.close(); }
    }
}

fn finish(app: &AppHandle, id: &str, outcome: &str) {
    let state = app.state::<AuthState>();
    let mut pending = state.0.lock().unwrap();
    if pending.as_ref().is_none_or(|attempt| attempt.id != id || (outcome == "expired" && attempt.exchanging)) { return; }
    pending.take();
    drop(pending);
    close_popups(app);
    if let Some(window) = app.get_webview_window(AUTH_WINDOW) { let _ = window.close(); }
    let _ = app.emit_to("main", "gog-auth-status", outcome);
}

fn navigate(app: &AppHandle, id: &str, session: &Session, url: &Url) -> bool {
    let result = callback(url);
    if matches!(result, Ok(None)) { return allowed_auth_url(url); }
    let state = app.state::<AuthState>();
    let mut pending = state.0.lock().unwrap();
    let Some(attempt) = pending.as_mut() else { return false };
    if attempt.id != id || attempt.started.elapsed() >= LIFETIME || attempt.exchanging { return false; }
    attempt.exchanging = true;
    drop(pending);
    let app = app.clone();
    let id = id.to_owned();
    let session = session.clone();
    std::thread::spawn(move || {
        let outcome = match result {
            Ok(Some(code)) => match send_code(&session, &code) { Ok(()) => "connected", Err(_) => "error" },
            _ => "error",
        };
        finish(&app, &id, outcome);
    });
    false
}

fn allowed_auth_url(url: &Url) -> bool {
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
        || url.as_str() == "about:blank"
}

fn popup(app: &AppHandle, id: &str, session: &Session, url: Url, features: NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    if !allowed_auth_url(&url) { return NewWindowResponse::Deny; }
    let label = {
        let state = app.state::<AuthState>();
        let mut pending = state.0.lock().unwrap();
        let Some(attempt) = pending.as_mut() else { return NewWindowResponse::Deny };
        if attempt.id != id || attempt.started.elapsed() >= LIFETIME || attempt.exchanging { return NewWindowResponse::Deny; }
        attempt.popups += 1;
        format!("gog-auth-popup-{}-{}", id, attempt.popups)
    };
    let nav_app = app.clone();
    let nav_id = id.to_owned();
    let nav_session = session.clone();
    let popup_app = app.clone();
    let popup_id = id.to_owned();
    let popup_session = session.clone();
    match WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .window_features(features)
        .title("GOG single sign-on")
        .inner_size(600.0, 750.0)
        .center()
        .resizable(true)
        .incognito(true)
        .on_navigation(move |url| navigate(&nav_app, &nav_id, &nav_session, url))
        .on_new_window(move |url, features| popup(&popup_app, &popup_id, &popup_session, url, features))
        .build()
    {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => { finish(app, id, "error"); NewWindowResponse::Deny }
    }
}

pub fn start(app: AppHandle, session: Session, login_url: String) -> Result<(), String> {
    let url = Url::parse(&login_url).map_err(|_| "Invalid GOG login URL")?;
    if url.scheme() != "https" || url.host_str() != Some("auth.gog.com") || url.port_or_known_default() != Some(443) || url.path() != "/auth" || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid GOG login URL".into());
    }
    let redirect = url.query_pairs().find(|(key, _)| key == "redirect_uri").map(|(_, value)| value.into_owned()).ok_or("Invalid GOG login URL")?;
    let target = Url::parse(&redirect).map_err(|_| "Invalid GOG login URL")?;
    if target.scheme() != "https" || target.host_str() != Some("embed.gog.com") || target.port_or_known_default() != Some(443) || target.path() != "/on_login_success" || target.query_pairs().find(|(key, _)| key == "origin").as_ref().map(|(_, value)| value.as_ref()) != Some("client") {
        return Err("Invalid GOG login URL".into());
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    {
        let state = app.state::<AuthState>();
        let mut pending = state.0.lock().unwrap();
        if pending.is_some() { return Err("A GOG login is already in progress".into()); }
        *pending = Some(Attempt { id: id.clone(), started: Instant::now(), exchanging: false, popups: 0 });
    }
    let nav_app = app.clone();
    let nav_id = id.clone();
    let nav_session = session.clone();
    let popup_app = app.clone();
    let popup_id = id.clone();
    let window = WebviewWindowBuilder::new(&app, AUTH_WINDOW, WebviewUrl::External(url))
        .title("Connect GOG")
        .inner_size(900.0, 700.0)
        .center()
        .resizable(true)
        .incognito(true)
        .on_navigation(move |url| navigate(&nav_app, &nav_id, &nav_session, url))
        .on_new_window(move |url, features| popup(&popup_app, &popup_id, &session, url, features))
        .build();
    if let Err(error) = window {
        let state = app.state::<AuthState>();
        state.0.lock().unwrap().take();
        return Err(format!("Could not open GOG login window: {error}"));
    }
    let expire_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LIFETIME);
        let state = expire_app.state::<AuthState>();
        let should_expire = state.0.lock().unwrap().as_ref().is_some_and(|attempt| attempt.id == id && !attempt.exchanging);
        if should_expire { finish(&expire_app, &id, "expired"); }
    });
    Ok(())
}

pub fn cancel(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AuthState>();
    let mut pending = state.0.lock().unwrap();
    if pending.as_ref().is_some_and(|attempt| attempt.exchanging) { return Err("Finishing GOG sign-in. Please wait.".into()); }
    pending.take();
    drop(pending);
    close_popups(app);
    if let Some(window) = app.get_webview_window(AUTH_WINDOW) { let _ = window.close(); }
    let _ = app.emit_to("main", "gog-auth-status", "cancelled");
    Ok(())
}

pub fn window_closed(app: &AppHandle) {
    let state = app.state::<AuthState>();
    let mut pending = state.0.lock().unwrap();
    if pending.as_ref().is_some_and(|attempt| attempt.exchanging) { return; }
    if pending.take().is_some() {
        drop(pending);
        close_popups(app);
        let _ = app.emit_to("main", "gog-auth-status", "cancelled");
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed_auth_url, callback};
    use tauri::Url;

    #[test]
    fn permits_https_and_blank_sso_windows_only() {
        for url in ["https://accounts.google.com/", "https://www.facebook.com/", "about:blank"] {
            assert!(allowed_auth_url(&Url::parse(url).unwrap()));
        }
        for url in ["http://accounts.google.com/", "javascript:alert(1)", "file:///C:/test", "data:text/html,test", "https://user:password@example.com/", "about:config"] {
            assert!(!allowed_auth_url(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn accepts_only_exact_gog_callback() {
        let valid = Url::parse("https://embed.gog.com/on_login_success?origin=client&code=TEST_CODE_123").unwrap();
        assert_eq!(callback(&valid).unwrap(), Some("TEST_CODE_123".into()));
        for url in [
            "https://embed.gog.com.attacker.example/on_login_success?origin=client&code=TEST_CODE_123",
            "https://attacker.example/?next=https://embed.gog.com/on_login_success?code=TEST_CODE_123",
            "https://embed.gog.com/other?origin=client&code=TEST_CODE_123",
            "https://embed.gog.com:8443/on_login_success?origin=client&code=TEST_CODE_123",
        ] {
            assert_eq!(callback(&Url::parse(url).unwrap()).unwrap(), None);
        }
        assert!(callback(&Url::parse("https://embed.gog.com/on_login_success?origin=client").unwrap()).is_err());
    }
}