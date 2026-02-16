use base64::Engine;
use keyring::Entry;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

#[derive(Serialize)]
struct GoogleAuthToken {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleTokenSuccess {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct GoogleTokenError {
    error: String,
    error_description: Option<String>,
}

const KEYRING_SERVICE: &str = "gcalendarwin";
const KEYRING_REFRESH_TOKEN_ACCOUNT: &str = "google_refresh_token";

#[tauri::command]
fn login_with_google(
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
) -> Result<GoogleAuthToken, String> {
    const SCOPE: &str = "https://www.googleapis.com/auth/calendar";

    let state = random_urlsafe(24);
    let code_verifier = random_urlsafe(64);
    let code_challenge = pkce_challenge(&code_verifier);

    let (listener_addr, final_redirect_uri) = match redirect_uri {
        Some(uri) => resolve_fixed_loopback_redirect(&uri)?,
        None => {
            let temp_listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("Cannot bind callback port: {e}"))?;
            let port = temp_listener
                .local_addr()
                .map_err(|e| format!("Cannot read callback port: {e}"))?
                .port();
            drop(temp_listener);
            (format!("127.0.0.1:{port}"), format!("http://127.0.0.1:{port}"))
        }
    };

    let listener =
        TcpListener::bind(&listener_addr).map_err(|e| format!("Cannot bind callback port: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Cannot configure callback listener: {e}"))?;

    let auth_url = Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", final_redirect_uri.as_str()),
            ("scope", SCOPE),
            ("state", state.as_str()),
            ("code_challenge", code_challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| format!("Failed to build Google auth URL: {e}"))?;

    tauri_plugin_opener::open_url(auth_url.as_str(), None::<String>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    let code = wait_for_auth_code(listener, &state, Duration::from_secs(180))?;
    let token = exchange_auth_code(
        &client_id,
        client_secret.as_deref(),
        &code_verifier,
        &code,
        &final_redirect_uri,
    )?;
    if let Some(refresh_token) = token.refresh_token.as_deref() {
        save_refresh_token(refresh_token)?;
    }
    Ok(GoogleAuthToken {
        access_token: token.access_token,
    })
}

#[tauri::command]
fn restore_google_session(
    client_id: String,
    client_secret: Option<String>,
) -> Result<GoogleAuthToken, String> {
    let refresh_token = load_refresh_token()?;
    let token = exchange_refresh_token(&client_id, client_secret.as_deref(), &refresh_token)?;
    if let Some(new_refresh_token) = token.refresh_token.as_deref() {
        save_refresh_token(new_refresh_token)?;
    }
    Ok(GoogleAuthToken {
        access_token: token.access_token,
    })
}

#[tauri::command]
fn clear_google_session() -> Result<(), String> {
    clear_refresh_token()
}

fn resolve_fixed_loopback_redirect(redirect_uri: &str) -> Result<(String, String), String> {
    let parsed = Url::parse(redirect_uri).map_err(|e| format!("Invalid redirect URI: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("Redirect URI must use http:// for local loopback callback.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Redirect URI is missing host.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("Redirect URI host must be localhost or 127.0.0.1.".to_string());
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Redirect URI must include a port.".to_string())?;
    let mut normalized = format!("http://{host}:{port}{}", parsed.path());
    if let Some(query) = parsed.query() {
        normalized.push('?');
        normalized.push_str(query);
    }
    Ok((format!("{host}:{port}"), normalized))
}

fn random_urlsafe(byte_len: usize) -> String {
    let mut bytes = vec![0_u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn wait_for_auth_code(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, String> {
    let started_at = Instant::now();
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut first_line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    reader
                        .read_line(&mut first_line)
                        .map_err(|e| format!("Failed to read callback request: {e}"))?;
                }

                let path = first_line
                    .split_whitespace()
                    .nth(1)
                    .ok_or_else(|| "Invalid callback request received.".to_string())?;

                let callback_url = Url::parse(&format!("http://127.0.0.1{path}"))
                    .map_err(|e| format!("Invalid callback URL: {e}"))?;
                let params: HashMap<String, String> =
                    callback_url.query_pairs().into_owned().collect();

                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<html><body><h3>Authentication completed. You can close this window.</h3></body></html>";
                stream
                    .write_all(response.as_bytes())
                    .map_err(|e| format!("Failed to write callback response: {e}"))?;

                if let Some(error) = params.get("error") {
                    return Err(format!("Google returned an OAuth error: {error}"));
                }

                let returned_state = params
                    .get("state")
                    .ok_or_else(|| "Missing OAuth state in callback.".to_string())?;
                if returned_state != expected_state {
                    return Err("OAuth state mismatch. Authentication aborted.".to_string());
                }

                let code = params
                    .get("code")
                    .ok_or_else(|| "Missing authorization code in callback.".to_string())?;
                return Ok(code.to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if started_at.elapsed() > timeout {
                    return Err("Google sign-in timed out. Try again.".to_string());
                }
                thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(format!("Failed while waiting for callback: {e}")),
        }
    }
}

fn exchange_auth_code(
    client_id: &str,
    client_secret: Option<&str>,
    code_verifier: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<GoogleTokenSuccess, String> {
    let client = reqwest::blocking::Client::new();
    let mut form_body: Vec<(&str, String)> = vec![
        ("client_id", client_id.to_string()),
        ("code_verifier", code_verifier.to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("grant_type", "authorization_code".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.trim().is_empty() {
            form_body.push(("client_secret", secret.to_string()));
        }
    }

    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form_body)
        .send()
        .map_err(|e| format!("Failed to exchange auth code for token: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read token response: {e}"))?;

    if !status.is_success() {
        if let Ok(err_payload) = serde_json::from_str::<GoogleTokenError>(&body) {
            let details = err_payload
                .error_description
                .unwrap_or_else(|| "No details".to_string());
            return Err(format!("Google token exchange failed: {} ({details})", err_payload.error));
        }
        return Err(format!(
            "Google token exchange failed with status {}.",
            status.as_u16()
        ));
    }

    serde_json::from_str::<GoogleTokenSuccess>(&body)
        .map_err(|e| format!("Failed to parse token response: {e}"))
}

fn exchange_refresh_token(
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<GoogleTokenSuccess, String> {
    let client = reqwest::blocking::Client::new();
    let mut form_body: Vec<(&str, String)> = vec![
        ("client_id", client_id.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.trim().is_empty() {
            form_body.push(("client_secret", secret.to_string()));
        }
    }

    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form_body)
        .send()
        .map_err(|e| format!("Failed to refresh access token: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read refresh response: {e}"))?;

    if !status.is_success() {
        if let Ok(err_payload) = serde_json::from_str::<GoogleTokenError>(&body) {
            let details = err_payload
                .error_description
                .unwrap_or_else(|| "No details".to_string());
            return Err(format!("Google token refresh failed: {} ({details})", err_payload.error));
        }
        return Err(format!(
            "Google token refresh failed with status {}.",
            status.as_u16()
        ));
    }

    serde_json::from_str::<GoogleTokenSuccess>(&body)
        .map_err(|e| format!("Failed to parse refresh response: {e}"))
}

fn save_refresh_token(token: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_REFRESH_TOKEN_ACCOUNT)
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("Failed to store refresh token securely: {e}"))
}

fn load_refresh_token() -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_REFRESH_TOKEN_ACCOUNT)
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    entry.get_password().map_err(|_| {
        "No saved Google session. Please connect your Google Calendar once.".to_string()
    })
}

fn clear_refresh_token() -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_REFRESH_TOKEN_ACCOUNT)
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear saved session: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            login_with_google,
            restore_google_session,
            clear_google_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
