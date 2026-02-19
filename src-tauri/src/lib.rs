use base64::Engine;
use keyring::Entry;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use url::Url;

#[derive(Clone, Serialize)]
struct GoogleSession {
    email: String,
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

#[derive(Deserialize)]
struct GoogleUserInfo {
    email: String,
}

#[derive(Serialize, Deserialize)]
struct OAuthHelperRequest {
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct OAuthHelperSession {
    email: String,
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct OAuthHelperResponse {
    ok: bool,
    session: Option<OAuthHelperSession>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct SavedAccounts {
    accounts: Vec<String>,
}

const KEYRING_SERVICE: &str = "gcalendarwin";
const ACCOUNTS_FILE: &str = "google_accounts.json";
const GOOGLE_AUTH_PROGRESS_EVENT: &str = "google_auth_progress";
static AUTH_CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Clone, Serialize)]
struct GoogleAuthProgressPayload {
    auth_id: String,
    stage: String,
    message: Option<String>,
    session: Option<GoogleSession>,
}

fn auth_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    AUTH_CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit_google_auth_progress(
    app: &tauri::AppHandle,
    auth_id: &str,
    stage: &str,
    message: Option<String>,
    session: Option<GoogleSession>,
) {
    let payload = GoogleAuthProgressPayload {
        auth_id: auth_id.to_string(),
        stage: stage.to_string(),
        message,
        session,
    };
    let _ = app.emit(GOOGLE_AUTH_PROGRESS_EVENT, payload);
}

#[tauri::command]
fn start_google_auth(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
) -> Result<String, String> {
    if client_id.trim().is_empty() {
        return Err("Missing VITE_GOOGLE_CLIENT_ID in .env".to_string());
    }

    let auth_id = random_urlsafe(12);
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = auth_cancel_flags()
            .lock()
            .map_err(|_| "Failed to acquire auth cancel lock.".to_string())?;
        map.insert(auth_id.clone(), Arc::clone(&cancel_flag));
    }

    emit_google_auth_progress(&app, &auth_id, "started", None, None);

    let app_for_thread = app.clone();
    let auth_id_for_thread = auth_id.clone();
    thread::spawn(move || {
        let request = OAuthHelperRequest {
            client_id,
            client_secret,
            redirect_uri,
        };

        let result = run_oauth_helper(&request, cancel_flag.as_ref(), |stage| {
            emit_google_auth_progress(&app_for_thread, &auth_id_for_thread, stage, None, None);
        });

        match result {
            Ok(session) => {
                let save_result = if let Some(refresh_token) = session.refresh_token.as_deref() {
                    save_refresh_token(&session.email, refresh_token)
                        .and_then(|_| upsert_saved_account(&app_for_thread, &session.email))
                } else {
                    Ok(())
                };

                if let Err(error) = save_result {
                    emit_google_auth_progress(
                        &app_for_thread,
                        &auth_id_for_thread,
                        "failed",
                        Some(error),
                        None,
                    );
                } else {
                    emit_google_auth_progress(
                        &app_for_thread,
                        &auth_id_for_thread,
                        "succeeded",
                        None,
                        Some(GoogleSession {
                            email: session.email,
                            access_token: session.access_token,
                        }),
                    );
                }
            }
            Err(error) => {
                let stage = if error.contains("timed out") {
                    "timeout"
                } else if error.contains("canceled") || error.contains("access_denied") {
                    "canceled"
                } else {
                    "failed"
                };
                emit_google_auth_progress(
                    &app_for_thread,
                    &auth_id_for_thread,
                    stage,
                    Some(error),
                    None,
                );
            }
        }

        if let Ok(mut map) = auth_cancel_flags().lock() {
            map.remove(&auth_id_for_thread);
        }
    });

    Ok(auth_id)
}

#[tauri::command]
fn cancel_google_auth(auth_id: String) -> Result<(), String> {
    let map = auth_cancel_flags()
        .lock()
        .map_err(|_| "Failed to acquire auth cancel lock.".to_string())?;
    if let Some(flag) = map.get(&auth_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

pub fn run_oauth_helper_if_requested() -> bool {
    let mut args = std::env::args();
    let _ = args.next();
    if args.next().as_deref() != Some("--oauth-helper") {
        return false;
    }

    let exit_code = match run_oauth_helper_stdio() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run_oauth_helper_stdio() -> Result<(), String> {
    let mut raw_request = String::new();
    std::io::stdin()
        .read_to_string(&mut raw_request)
        .map_err(|e| format!("Failed to read helper request payload: {e}"))?;

    let helper_request = serde_json::from_str::<OAuthHelperRequest>(raw_request.trim())
        .map_err(|e| format!("Invalid helper request payload: {e}"))?;

    let helper_response = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let canceled = AtomicBool::new(false);
        run_oauth_helper(&helper_request, &canceled, |_| {})
    })) {
        Ok(Ok(session)) => OAuthHelperResponse {
            ok: true,
            session: Some(session),
            error: None,
        },
        Ok(Err(error)) => OAuthHelperResponse {
            ok: false,
            session: None,
            error: Some(error),
        },
        Err(_) => OAuthHelperResponse {
            ok: false,
            session: None,
            error: Some("Authentication helper crashed unexpectedly.".to_string()),
        },
    };

    let response_json = serde_json::to_string(&helper_response)
        .map_err(|e| format!("Failed to serialize helper response payload: {e}"))?;
    println!("{response_json}");
    Ok(())
}

fn run_oauth_helper<F>(
    request: &OAuthHelperRequest,
    canceled: &AtomicBool,
    mut on_progress: F,
) -> Result<OAuthHelperSession, String>
where
    F: FnMut(&str),
{
    const SCOPE: &str = "openid email https://www.googleapis.com/auth/calendar";

    let state = random_urlsafe(24);
    let code_verifier = random_urlsafe(64);
    let code_challenge = pkce_challenge(&code_verifier);

    let (listener_addr, final_redirect_uri) = match request.redirect_uri.as_deref() {
        Some(uri) => resolve_fixed_loopback_redirect(uri)?,
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
            ("client_id", request.client_id.as_str()),
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
    on_progress("browser_opened");

    let code = wait_for_auth_code(listener, &state, Duration::from_secs(180), canceled)?;
    on_progress("callback_received");
    let token = exchange_auth_code(
        &request.client_id,
        request.client_secret.as_deref(),
        &code_verifier,
        &code,
        &final_redirect_uri,
    )?;

    let email = fetch_user_email(&token.access_token)?;

    Ok(OAuthHelperSession {
        email,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
    })
}

#[tauri::command]
fn login_with_google(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
) -> Result<GoogleSession, String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        login_with_google_inner(
            &app,
            &client_id,
            client_secret.as_deref(),
            redirect_uri.as_deref(),
        )
    }));

    match result {
        Ok(outcome) => outcome,
        Err(_) => Err("Google sign-in failed unexpectedly. Please try again.".to_string()),
    }
}

fn login_with_google_inner(
    app: &tauri::AppHandle,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: Option<&str>,
) -> Result<GoogleSession, String> {
    let helper_output = run_oauth_helper_process(client_id, client_secret, redirect_uri)?;

    if let Some(refresh_token) = helper_output.refresh_token.as_deref() {
        save_refresh_token(&helper_output.email, refresh_token)?;
        upsert_saved_account(app, &helper_output.email)?;
    }

    Ok(GoogleSession {
        email: helper_output.email,
        access_token: helper_output.access_token,
    })
}

fn run_oauth_helper_process(
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: Option<&str>,
) -> Result<OAuthHelperSession, String> {
    let helper_request = OAuthHelperRequest {
        client_id: client_id.to_string(),
        client_secret: client_secret.map(|value| value.to_string()),
        redirect_uri: redirect_uri.map(|value| value.to_string()),
    };

    let request_json = serde_json::to_string(&helper_request)
        .map_err(|e| format!("Failed to serialize auth helper payload: {e}"))?;
    let current_exe =
        std::env::current_exe().map_err(|e| format!("Failed to resolve current executable: {e}"))?;

    let mut child = Command::new(current_exe)
        .arg("--oauth-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start authentication helper process: {e}"))?;

    {
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            return Err("Authentication helper stdin was not available.".to_string());
        };
        stdin
            .write_all(request_json.as_bytes())
            .map_err(|e| format!("Failed to send auth payload to helper process: {e}"))?;
    }

    let timeout = Duration::from_secs(210);
    let started_at = Instant::now();
    loop {
        if started_at.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Google sign-in timed out. Please try again.".to_string());
        }

        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed while waiting for authentication helper: {e}"));
            }
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read authentication helper output: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_msg = stderr.trim();
        if stderr_msg.is_empty() {
            return Err("Authentication helper process exited unexpectedly.".to_string());
        }
        return Err(format!(
            "Authentication helper process failed: {stderr_msg}"
        ));
    }

    let response_text = String::from_utf8(output.stdout)
        .map_err(|e| format!("Authentication helper returned invalid UTF-8: {e}"))?;
    let helper_response = serde_json::from_str::<OAuthHelperResponse>(response_text.trim())
        .map_err(|e| format!("Failed to parse authentication helper response: {e}"))?;

    if helper_response.ok {
        return helper_response
            .session
            .ok_or_else(|| "Authentication helper returned success without session data.".to_string());
    }

    Err(helper_response
        .error
        .unwrap_or_else(|| "Authentication helper failed without details.".to_string()))
}

#[tauri::command]
fn restore_google_sessions(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
) -> Result<Vec<GoogleSession>, String> {
    let saved = load_saved_accounts(&app)?;
    let mut sessions = Vec::new();

    for email in saved.accounts {
        let refresh_token = match load_refresh_token(&email) {
            Ok(token) => token,
            Err(_) => continue,
        };

        let refreshed = match exchange_refresh_token(&client_id, client_secret.as_deref(), &refresh_token)
        {
            Ok(token) => token,
            Err(_) => continue,
        };

        if let Some(new_refresh_token) = refreshed.refresh_token.as_deref() {
            let _ = save_refresh_token(&email, new_refresh_token);
        }

        sessions.push(GoogleSession {
            email,
            access_token: refreshed.access_token,
        });
    }

    Ok(sessions)
}

#[tauri::command]
fn clear_google_session(app: tauri::AppHandle, email: String) -> Result<(), String> {
    clear_refresh_token(&email)?;
    remove_saved_account(&app, &email)
}

#[tauri::command]
fn refresh_google_session(
    client_id: String,
    client_secret: Option<String>,
    email: String,
) -> Result<GoogleSession, String> {
    let refresh_token = load_refresh_token(&email)?;
    let refreshed = exchange_refresh_token(&client_id, client_secret.as_deref(), &refresh_token)?;

    if let Some(new_refresh_token) = refreshed.refresh_token.as_deref() {
        let _ = save_refresh_token(&email, new_refresh_token);
    }

    Ok(GoogleSession {
        email,
        access_token: refreshed.access_token,
    })
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
    canceled: &AtomicBool,
) -> Result<String, String> {
    let started_at = Instant::now();
    loop {
        if canceled.load(Ordering::SeqCst) {
            return Err("Google sign-in was canceled.".to_string());
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let mut first_line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    match reader.read_line(&mut first_line) {
                        Ok(0) => continue,
                        Ok(_) => {}
                        Err(e)
                            if e.kind() == std::io::ErrorKind::TimedOut
                                || e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            continue;
                        }
                        Err(_) => continue,
                    }
                }

                if first_line.trim().is_empty() {
                    continue;
                }

                let Some(path) = first_line.split_whitespace().nth(1) else {
                    continue;
                };

                let callback_url = match Url::parse(&format!("http://127.0.0.1{path}")) {
                    Ok(url) => url,
                    Err(_) => continue,
                };
                let params: HashMap<String, String> =
                    callback_url.query_pairs().into_owned().collect();

                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<html><body><h3>Authentication completed. You can close this window.</h3></body></html>";
                let _ = stream.write_all(response.as_bytes());

                if let Some(error) = params.get("error") {
                    return Err(format!("Google returned an OAuth error: {error}"));
                }

                let Some(returned_state) = params.get("state") else {
                    continue;
                };
                if returned_state != expected_state {
                    continue;
                }

                let Some(code) = params.get("code") else {
                    continue;
                };
                return Ok(code.to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if canceled.load(Ordering::SeqCst) {
                    return Err("Google sign-in was canceled.".to_string());
                }
                if started_at.elapsed() > timeout {
                    return Err("Google sign-in was canceled or timed out. Try again.".to_string());
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

fn fetch_user_email(access_token: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let response = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("Failed to fetch Google user profile: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read Google user profile: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "Failed to fetch Google account email (status {}).",
            status.as_u16()
        ));
    }

    let profile = serde_json::from_str::<GoogleUserInfo>(&body)
        .map_err(|e| format!("Failed to parse Google user profile: {e}"))?;
    Ok(profile.email)
}

fn keyring_account_name(email: &str) -> String {
    format!("google_refresh_token:{email}")
}

fn save_refresh_token(email: &str, token: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &keyring_account_name(email))
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("Failed to store refresh token securely: {e}"))
}

fn load_refresh_token(email: &str) -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, &keyring_account_name(email))
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("No refresh token available for {email}: {e}"))
}

fn clear_refresh_token(email: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &keyring_account_name(email))
        .map_err(|e| format!("Failed to open secure storage: {e}"))?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear saved session: {e}")),
    }
}

fn accounts_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data directory: {e}"))?;
    Ok(dir.join(ACCOUNTS_FILE))
}

fn load_saved_accounts(app: &tauri::AppHandle) -> Result<SavedAccounts, String> {
    let path = accounts_file_path(app)?;
    if !path.exists() {
        return Ok(SavedAccounts::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read saved accounts file: {e}"))?;
    serde_json::from_str::<SavedAccounts>(&raw)
        .map_err(|e| format!("Failed to parse saved accounts file: {e}"))
}

fn save_accounts(app: &tauri::AppHandle, saved: &SavedAccounts) -> Result<(), String> {
    let path = accounts_file_path(app)?;
    let raw = serde_json::to_string(saved)
        .map_err(|e| format!("Failed to serialize saved accounts: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("Failed to write saved accounts file: {e}"))
}

fn upsert_saved_account(app: &tauri::AppHandle, email: &str) -> Result<(), String> {
    let mut saved = load_saved_accounts(app)?;
    if !saved.accounts.iter().any(|e| e == email) {
        saved.accounts.push(email.to_string());
        save_accounts(app, &saved)?;
    }
    Ok(())
}

fn remove_saved_account(app: &tauri::AppHandle, email: &str) -> Result<(), String> {
    let mut saved = load_saved_accounts(app)?;
    saved.accounts.retain(|e| e != email);
    save_accounts(app, &saved)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::InvalidIcon(std::io::Error::other("default window icon not found").into()))?;

            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_google_auth,
            cancel_google_auth,
            login_with_google,
            restore_google_sessions,
            clear_google_session,
            refresh_google_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
