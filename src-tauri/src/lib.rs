use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

const MAX_CONTROL_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTROL_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CONTROL_ERROR_MESSAGE_BYTES: usize = 1024;
const RUNTIME_UPDATED_EVENT: &str = "xorein://runtime-updated";

#[derive(Default)]
struct XoreinRuntimeState {
    pending_deeplink: Mutex<VecDeque<String>>,
}

/// Resolves the standard xorein data directory on the current platform.
fn xorein_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        dirs_next::data_local_dir().map(|d| d.join("xorein"))
    }
    #[cfg(target_os = "macos")]
    {
        dirs_next::data_dir().map(|d| d.join("xorein"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs_next::data_dir().map(|d| d.join("xorein"))
    }
}

/// Resolves the path to the xorein control token file on the current platform.
fn xorein_token_path() -> Option<PathBuf> {
    trusted_xorein_data_dir_for_reads().map(|d| d.join("control.token"))
}

fn xorein_control_addr_path() -> Option<PathBuf> {
    trusted_xorein_data_dir_for_reads().map(|d| d.join("control.addr"))
}

/// Returns the xorein control token, reading from the standard data dir path.
/// Returns an empty string if the file doesn't exist or can't be read.
fn read_xorein_control_token() -> String {
    xorein_token_path()
        .and_then(|p| read_regular_utf8_file(&p))
        .map(|s| s.trim().to_owned())
        .filter(|s| is_usable_control_token(s))
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
struct XoreinRuntimeConfig {
    control_endpoint: String,
    control_ready: bool,
    data_dir: Option<String>,
}

#[derive(serde::Serialize)]
struct XoreinControlApiResponse {
    status: u16,
    body: Option<serde_json::Value>,
}

#[derive(Default)]
struct ControlResponseHeaders {
    chunked: bool,
    content_length: Option<usize>,
}

fn read_xorein_control_endpoint() -> String {
    xorein_control_addr_path()
        .and_then(|p| read_regular_utf8_file(&p))
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .and_then(|addr| trusted_control_endpoint(&addr))
        .unwrap_or_default()
}

fn xorein_control_ready(endpoint: &str) -> bool {
    let token = read_xorein_control_token();
    xorein_control_ready_with_token(endpoint, &token)
}

fn xorein_control_ready_with_token(endpoint: &str, token: &str) -> bool {
    control_endpoint_accepts_token(endpoint, token)
}

fn control_endpoint_accepts_token(endpoint: &str, token: &str) -> bool {
    matches!(
        request_xorein_control_api_inner_with_timeout(
            endpoint,
            token,
            "GET",
            "/v1/state",
            None,
            Duration::from_millis(500)
        ),
        Ok(response) if response.status == 200
    )
}

fn read_regular_utf8_file(path: &Path) -> Option<String> {
    let file = open_regular_utf8_file(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.file_type().is_file() || !has_private_file_permissions(&metadata) {
        return None;
    }
    let mut contents = String::new();
    let mut reader = file;
    reader.read_to_string(&mut contents).ok()?;
    Some(contents)
}

fn open_regular_utf8_file(path: &Path) -> std::io::Result<std::fs::File> {
    open_regular_utf8_file_impl(path)
}

#[cfg(unix)]
fn open_regular_utf8_file_impl(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    options.custom_flags(libc::O_NOFOLLOW);
    options.open(path)
}

#[cfg(not(unix))]
fn open_regular_utf8_file_impl(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().read(true).open(path)
}

fn trusted_xorein_data_dir_for_reads() -> Option<PathBuf> {
    let path = xorein_data_dir()?;
    if is_trusted_data_dir_for_reads(&path) {
        Some(path)
    } else {
        None
    }
}

fn is_trusted_data_dir_for_reads(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            !file_type.is_symlink()
                && file_type.is_dir()
                && has_private_directory_permissions(&metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(unix)]
fn has_private_file_permissions(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn has_private_file_permissions(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn has_private_directory_permissions(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn has_private_directory_permissions(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn is_usable_control_token(token: &str) -> bool {
    token.len() >= 32
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn trusted_control_endpoint(raw: &str) -> Option<String> {
    let addr = raw
        .trim()
        .strip_prefix("http://")
        .unwrap_or(raw.trim())
        .trim();
    let socket_addr = endpoint_socket_addr(addr)?;
    if !socket_addr.ip().is_loopback() {
        return None;
    }
    Some(format!("http://{}", socket_addr))
}

impl XoreinRuntimeConfig {
    fn from_endpoint(endpoint: String) -> Self {
        let endpoint = trusted_control_endpoint(&endpoint).unwrap_or_default();
        Self {
            control_ready: xorein_control_ready(&endpoint),
            control_endpoint: endpoint,
            data_dir: xorein_data_dir().map(|p| p.to_string_lossy().to_string()),
        }
    }
}

fn resolve_runtime_control_endpoint(_primary: String, secondary: String) -> String {
    // Never let webview-controlled data choose where the private control token
    // is sent. The endpoint persisted by the local xorein runtime is the only
    // authenticated destination; an arbitrary loopback service is not trusted
    // merely because it is local.
    trusted_control_endpoint(&secondary).unwrap_or_default()
}

#[tauri::command]
fn read_xorein_runtime_status() -> XoreinRuntimeConfig {
    XoreinRuntimeConfig::from_endpoint(read_xorein_control_endpoint())
}

fn endpoint_socket_addr(endpoint: &str) -> Option<SocketAddr> {
    let endpoint = endpoint
        .trim()
        .strip_prefix("http://")
        .unwrap_or(endpoint.trim());
    if let Ok(addr) = endpoint.parse::<SocketAddr>() {
        return Some(addr);
    }

    endpoint
        .to_socket_addrs()
        .ok()?
        .find(|addr| match addr.ip() {
            IpAddr::V4(ip) => ip.is_loopback(),
            IpAddr::V6(ip) => ip.is_loopback(),
        })
}

fn request_xorein_control_api_inner(
    endpoint: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<XoreinControlApiResponse, String> {
    request_xorein_control_api_inner_with_timeout(
        endpoint,
        token,
        method,
        path,
        body,
        Duration::from_secs(6),
    )
}

fn request_xorein_control_api_inner_with_timeout(
    endpoint: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<XoreinControlApiResponse, String> {
    let endpoint = trusted_control_endpoint(endpoint)
        .ok_or_else(|| "xorein control endpoint is unavailable or untrusted".to_string())?;
    let addr = endpoint_socket_addr(&endpoint)
        .ok_or_else(|| "xorein control endpoint is unavailable".to_string())?;
    let method = normalized_control_method(method)?;
    let path = normalized_control_path(path)?;
    if !is_usable_control_token(token) {
        return Err("xorein control token is unavailable or invalid".to_string());
    }
    if method == "GET" && body.is_some() {
        return Err("xorein control GET requests cannot include a body".to_string());
    }
    let body_bytes = match body {
        Some(value) => serde_json::to_vec(&value).map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    if body_bytes.len() > MAX_CONTROL_REQUEST_BODY_BYTES {
        return Err("xorein control request body is too large".to_string());
    }

    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|error| format!("connect xorein control: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("set read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("set write timeout: {error}"))?;

    let host = if addr.is_ipv6() {
        format!("[{}]:{}", addr.ip(), addr.port())
    } else {
        addr.to_string()
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
        body_bytes.len()
    );
    request.push_str("Authorization: Bearer ");
    request.push_str(token);
    request.push_str("\r\n");
    if !body_bytes.is_empty() {
        request.push_str("Content-Type: application/json\r\n");
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body_bytes))
        .map_err(|error| format!("write xorein control request: {error}"))?;

    let mut raw = Vec::new();
    let mut limited = stream.take(MAX_CONTROL_RESPONSE_BYTES + 1);
    limited
        .read_to_end(&mut raw)
        .map_err(|error| format!("read xorein control response: {error}"))?;
    if raw.len() as u64 > MAX_CONTROL_RESPONSE_BYTES {
        return Err("xorein control response is too large".to_string());
    }
    parse_control_http_response(&raw)
}

fn normalized_control_method(method: &str) -> Result<&'static str, String> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok("GET"),
        "POST" => Ok("POST"),
        "PUT" => Ok("PUT"),
        "PATCH" => Ok("PATCH"),
        "DELETE" => Ok("DELETE"),
        _ => Err("unsupported xorein control method".to_string()),
    }
}

fn normalized_control_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with("/v1/") || path.bytes().any(is_unsafe_control_path_byte) {
        return Err("unsupported xorein control path".to_string());
    }
    let path_only = path.split('?').next().unwrap_or(path);
    if path_only
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err("unsupported xorein control path".to_string());
    }
    Ok(path.to_string())
}

fn is_unsafe_control_path_byte(byte: u8) -> bool {
    !(0x21..=0x7e).contains(&byte) || matches!(byte, b'#' | b'\\')
}

fn parse_control_http_response(raw: &[u8]) -> Result<XoreinControlApiResponse, String> {
    let Some(header_end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err("invalid xorein control response".to_string());
    };
    let headers = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "invalid xorein control response headers".to_string())?;
    let mut lines = headers.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "missing xorein control status line".to_string())?;
    let status = parse_control_status_line(status_line)?;
    let response_headers = parse_control_response_headers(lines)?;
    let response_body = &raw[header_end + 4..];
    let body_bytes = if response_headers.chunked {
        decode_chunked_body(response_body)?
    } else {
        bounded_control_body(response_body, response_headers.content_length)?
    };
    let body = if body_bytes.is_empty() {
        None
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(body) => Some(body),
            Err(_) if status >= 400 => Some(serde_json::json!({
                "code": format!("http_{status}"),
                "message": control_error_body_message(&body_bytes),
            })),
            Err(error) => {
                return Err(format!("invalid xorein control JSON response: {error}"));
            }
        }
    };
    Ok(XoreinControlApiResponse { status, body })
}

fn parse_control_response_headers<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> Result<ControlResponseHeaders, String> {
    let mut headers = ControlResponseHeaders::default();
    for line in lines {
        let (name, value) = parse_control_header_line(line)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            let tokens: Vec<String> = value
                .split(',')
                .map(|token| token.trim().to_ascii_lowercase())
                .filter(|token| !token.is_empty())
                .collect();
            if tokens.len() == 1 && tokens[0] == "chunked" {
                headers.chunked = true;
            } else if !tokens.is_empty() {
                return Err("unsupported xorein control transfer encoding".to_string());
            }
        } else if name.eq_ignore_ascii_case("content-length") {
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "invalid xorein control content length".to_string())?;
            if headers
                .content_length
                .is_some_and(|existing| existing != length)
            {
                return Err("conflicting xorein control content length".to_string());
            }
            headers.content_length = Some(length);
        }
    }
    Ok(headers)
}

fn parse_control_header_line(line: &str) -> Result<(&str, &str), String> {
    if !is_valid_control_header_line(line) {
        return Err("invalid xorein control response header".to_string());
    }
    let (name, value) = line
        .split_once(':')
        .ok_or_else(|| "invalid xorein control response header".to_string())?;
    if name.is_empty() || !name.bytes().all(is_http_token_byte) {
        return Err("invalid xorein control response header".to_string());
    }
    Ok((name, value))
}

fn parse_control_status_line(status_line: &str) -> Result<u16, String> {
    let mut parts = status_line.split_whitespace();
    let version = parts
        .next()
        .ok_or_else(|| "missing xorein control HTTP version".to_string())?;
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err("unsupported xorein control HTTP version".to_string());
    }
    let status_text = parts
        .next()
        .ok_or_else(|| "missing xorein control status".to_string())?;
    if status_text.len() != 3 || !status_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid xorein control status".to_string());
    }
    let status = status_text
        .parse::<u16>()
        .map_err(|_| "invalid xorein control status".to_string())?;
    if !(200..=599).contains(&status) {
        return Err("unsupported xorein control status".to_string());
    }
    Ok(status)
}

fn is_valid_control_header_line(line: &str) -> bool {
    !line.is_empty()
        && line.contains(':')
        && line
            .bytes()
            .all(|byte| byte == b'\t' || byte >= 0x20 && byte != 0x7f)
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn bounded_control_body(body: &[u8], content_length: Option<usize>) -> Result<Vec<u8>, String> {
    let Some(content_length) = content_length else {
        return Ok(body.to_vec());
    };
    if body.len() < content_length {
        return Err("truncated xorein control response body".to_string());
    }
    if body.len() > content_length {
        return Err("oversized xorein control response body".to_string());
    }
    Ok(body.to_vec())
}

fn control_error_body_message(body_bytes: &[u8]) -> String {
    let body = String::from_utf8_lossy(body_bytes);
    let message = body.trim();
    if message.is_empty() {
        return "xorein request failed".to_string();
    }
    message
        .chars()
        .take(MAX_CONTROL_ERROR_MESSAGE_BYTES)
        .collect::<String>()
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let Some(line_end) = raw[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
        else {
            return Err("invalid chunked xorein control response".to_string());
        };
        let size_line = std::str::from_utf8(&raw[cursor..line_end])
            .map_err(|_| "invalid chunk size".to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size =
            usize::from_str_radix(size_hex, 16).map_err(|_| "invalid chunk size".to_string())?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        if raw.len() < cursor + size + 2 || &raw[cursor + size..cursor + size + 2] != b"\r\n" {
            return Err("invalid chunked xorein control body".to_string());
        }
        decoded.extend_from_slice(&raw[cursor..cursor + size]);
        cursor += size + 2;
    }
}

#[tauri::command]
fn read_xorein_runtime_config() -> XoreinRuntimeConfig {
    XoreinRuntimeConfig::from_endpoint(read_xorein_control_endpoint())
}

#[tauri::command]
fn request_xorein_control_api(
    app: AppHandle,
    endpoint: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<XoreinControlApiResponse, String> {
    let endpoint = resolve_runtime_control_endpoint(endpoint, read_xorein_control_endpoint());
    let token = read_xorein_control_token();
    let response = request_xorein_control_api_inner(&endpoint, &token, &method, &path, body)
        .map_err(|error| error.to_string())?;
    if should_emit_runtime_updated(&method, &path, response.status) {
        let _ = app.emit(RUNTIME_UPDATED_EVENT, path.trim());
    }
    Ok(response)
}

fn should_emit_runtime_updated(method: &str, path: &str, status: u16) -> bool {
    if !(200..300).contains(&status) {
        return false;
    }
    let Ok(method) = normalized_control_method(method) else {
        return false;
    };
    let Ok(path) = normalized_control_path(path) else {
        return false;
    };
    match method {
        "GET" => false,
        "POST" => !matches!(
            path.as_str(),
            "/v1/servers/discover"
                | "/v1/messages/search"
                | "/v1/notifications/search"
                | "/v1/mentions/search"
                | "/v1/identities/backup"
        ),
        "PUT" | "PATCH" | "DELETE" => true,
        _ => false,
    }
}

#[tauri::command]
fn consume_pending_deeplink(state: State<'_, XoreinRuntimeState>) -> Vec<String> {
    state
        .pending_deeplink
        .lock()
        .map(|mut pending| pending.drain(..).collect())
        .unwrap_or_default()
}

/// Forwards an aether:// deep-link URL received by the OS to the webview.
fn forward_deeplink(app: &AppHandle, url: &str) {
    if let Some(state) = app.try_state::<XoreinRuntimeState>() {
        if let Ok(mut pending) = state.pending_deeplink.lock() {
            pending.push_back(url.to_string());
        }
    }
    let _ = app.emit("harmolyn://deeplink", url);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(XoreinRuntimeState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // When a second instance is launched with a deeplink arg, forward it.
            let url = args.get(1).cloned().unwrap_or_default();
            if url.starts_with("aether://") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                forward_deeplink(app, &url);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register aether:// scheme for deep links.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                app.deep_link().register("aether")?;
            }

            // Listen for OS-level deep links forwarded by tauri-plugin-deep-link.
            let app_handle: AppHandle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.set_focus();
                    }
                    forward_deeplink(&app_handle, url.as_ref());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_xorein_runtime_config,
            read_xorein_runtime_status,
            request_xorein_control_api,
            consume_pending_deeplink
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("error while running harmolyn: {error}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod tests {
    use super::{
        endpoint_socket_addr, is_trusted_data_dir_for_reads, is_usable_control_token,
        normalized_control_method, normalized_control_path, parse_control_http_response,
        read_regular_utf8_file, request_xorein_control_api_inner_with_timeout,
        resolve_runtime_control_endpoint, should_emit_runtime_updated, trusted_control_endpoint,
        xorein_control_ready_with_token, XoreinRuntimeConfig,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("harmolyn-{name}-{nonce}"))
    }

    fn spawn_control_probe_server(expected_token: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind control probe listener");
        let endpoint = listener
            .local_addr()
            .expect("control probe addr")
            .to_string();
        thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0_u8; 2048];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]);
            let expected_auth = format!("Authorization: Bearer {expected_token}\r\n");
            let has_auth = request.contains("Authorization: Bearer ");
            let (status, body) = if has_auth && request.contains(&expected_auth) {
                ("200 OK", "{}")
            } else {
                (
                    "401 Unauthorized",
                    "{\"code\":\"unauthorized\",\"message\":\"invalid bearer token\"}",
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        endpoint
    }

    #[test]
    fn trusted_control_endpoint_accepts_loopback_addresses() {
        assert_eq!(
            trusted_control_endpoint("127.0.0.1:7711").as_deref(),
            Some("http://127.0.0.1:7711")
        );
        assert_eq!(
            trusted_control_endpoint("http://127.0.0.1:7711").as_deref(),
            Some("http://127.0.0.1:7711")
        );
        assert_eq!(
            trusted_control_endpoint("[::1]:7711").as_deref(),
            Some("http://[::1]:7711")
        );
    }

    #[test]
    fn trusted_control_endpoint_rejects_remote_and_wildcard_addresses() {
        assert_eq!(trusted_control_endpoint("0.0.0.0:7711"), None);
        assert_eq!(trusted_control_endpoint("192.0.2.10:7711"), None);
        assert_eq!(trusted_control_endpoint("https://127.0.0.1:7711"), None);
        assert_eq!(trusted_control_endpoint("not an endpoint"), None);
    }

    #[test]
    fn endpoint_socket_addr_resolves_localhost_only_when_loopback() {
        let addr = endpoint_socket_addr("localhost:7711").expect("localhost should resolve");
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 7711);
    }

    #[test]
    fn native_control_request_restricts_methods_and_paths() {
        assert_eq!(normalized_control_method("post").unwrap(), "POST");
        assert!(normalized_control_method("TRACE").is_err());
        assert_eq!(normalized_control_path("/v1/state").unwrap(), "/v1/state");
        assert_eq!(
            normalized_control_path(" /v1/messages/search?limit=10 ").unwrap(),
            "/v1/messages/search?limit=10"
        );
        assert!(normalized_control_path("/admin").is_err());
        assert!(normalized_control_path("/v1/state\r\nX-Bad: true").is_err());
        assert!(normalized_control_path("/v1/state HTTP/1.1").is_err());
        assert!(normalized_control_path("/v1/state\tX-Bad").is_err());
        assert!(normalized_control_path("/v1/state\0").is_err());
        assert!(normalized_control_path("/v1/state\u{7f}").is_err());
        assert!(normalized_control_path("/v1/state/é").is_err());
        assert!(normalized_control_path("/v1/state#fragment").is_err());
        assert!(normalized_control_path("/v1/state\\admin").is_err());
        assert!(normalized_control_path("/v1/messages/../state").is_err());
        assert!(normalized_control_path("/v1/messages/./state?limit=10").is_err());
    }

    #[test]
    fn native_control_request_emits_runtime_updates_only_for_mutations() {
        assert!(!should_emit_runtime_updated("GET", "/v1/state", 200));
        assert!(!should_emit_runtime_updated(
            "POST",
            "/v1/servers/discover",
            200
        ));
        assert!(!should_emit_runtime_updated(
            "POST",
            "/v1/messages/search",
            200
        ));
        assert!(!should_emit_runtime_updated(
            "POST",
            "/v1/notifications/search",
            200
        ));
        assert!(!should_emit_runtime_updated(
            "POST",
            "/v1/mentions/search",
            200
        ));
        assert!(!should_emit_runtime_updated(
            "POST",
            "/v1/identities/backup",
            200
        ));
        assert!(should_emit_runtime_updated("POST", "/v1/servers", 200));
        assert!(should_emit_runtime_updated(
            "PATCH",
            "/v1/messages/123",
            200
        ));
        assert!(should_emit_runtime_updated(
            "DELETE",
            "/v1/messages/123",
            200
        ));
        assert!(!should_emit_runtime_updated("POST", "/v1/servers", 500));
    }

    #[test]
    fn native_control_request_rejects_get_bodies_before_connecting() {
        let result = request_xorein_control_api_inner_with_timeout(
            "http://127.0.0.1:9",
            "abcdefghijklmnopqrstuvwxyzABCDEF_0123456789-",
            "GET",
            "/v1/state",
            Some(serde_json::json!({ "unexpected": true })),
            Duration::from_millis(1),
        );
        let Err(error) = result else {
            panic!("GET body should be rejected before connecting");
        };

        assert_eq!(error, "xorein control GET requests cannot include a body");
    }

    #[test]
    fn native_control_response_parses_plain_and_chunked_json() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let parsed = parse_control_http_response(plain).expect("parse plain response");
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body.unwrap()["ok"], true);

        let chunked = b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{\"id\":1}\r\n0\r\n\r\n";
        let parsed = parse_control_http_response(chunked).expect("parse chunked response");
        assert_eq!(parsed.status, 201);
        assert_eq!(parsed.body.unwrap()["id"], 1);

        let error_text =
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nboom";
        let parsed =
            parse_control_http_response(error_text).expect("parse non-json error response");
        assert_eq!(parsed.status, 500);
        let body = parsed.body.expect("error response body");
        assert_eq!(body["code"], "http_500");
        assert_eq!(body["message"], "boom");

        let success_text = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nnot json";
        assert!(parse_control_http_response(success_text).is_err());
    }

    #[test]
    fn native_control_response_rejects_malformed_http_metadata() {
        assert!(parse_control_http_response(
            b"HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n{}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 99 Nope\r\nContent-Type: application/json\r\n\r\n{}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 700 Nope\r\nContent-Type: application/json\r\n\r\n{}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 two OK\r\nContent-Type: application/json\r\n\r\n{}"
        )
        .is_err());
        assert!(
            parse_control_http_response(b"HTTP/1.1 200 OK\r\nBroken-Header\r\n\r\n{}").is_err()
        );
    }

    #[test]
    fn native_control_response_validates_body_framing() {
        let exact_length = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let parsed = parse_control_http_response(exact_length).expect("parse exact body length");
        assert_eq!(parsed.body.unwrap()["ok"], true);

        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nX-Debug: transfer-encoding: chunked\r\n\r\n{\"ok\":true}"
        )
        .is_ok());
        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{\"ok\":true}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{\"ok\":true}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Length: 12\r\n\r\n{\"ok\":true}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n{\"ok\":true}"
        )
        .is_err());
        assert!(parse_control_http_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n"
        )
        .is_err());
    }

    #[test]
    fn is_usable_control_token_matches_xorein_token_format() {
        assert!(is_usable_control_token(
            "abcdefghijklmnopqrstuvwxyzABCDEF_0123456789-"
        ));
        assert!(!is_usable_control_token("short-token"));
        assert!(!is_usable_control_token(
            "abcdefghijklmnopqrstuvwxyzABCDEF\n"
        ));
        assert!(!is_usable_control_token(
            "abcdefghijklmnopqrstuvwxyzABCDEF="
        ));
    }

    #[test]
    fn runtime_config_serialization_does_not_expose_control_token() {
        let serialized = serde_json::to_value(XoreinRuntimeConfig {
            control_endpoint: "http://127.0.0.1:7711".to_string(),
            control_ready: true,
            data_dir: Some("/tmp/xorein".to_string()),
        })
        .expect("runtime config should serialize");

        assert!(serialized.get("control_endpoint").is_some());
        assert!(serialized.get("control_ready").is_some());
        assert!(serialized.get("control_token").is_none());
    }

    #[test]
    fn runtime_config_accepts_only_loopback_control_endpoints() {
        let config = XoreinRuntimeConfig::from_endpoint("http://127.0.0.1:7811".to_string());

        assert_eq!(config.control_endpoint, "http://127.0.0.1:7811");
    }

    #[test]
    fn runtime_config_rejects_non_loopback_control_endpoints() {
        let config = XoreinRuntimeConfig::from_endpoint("http://192.0.2.1:7711".to_string());

        assert_eq!(config.control_endpoint, "");
    }

    #[test]
    fn resolve_runtime_control_endpoint_uses_only_the_authenticated_runtime_endpoint() {
        assert_eq!(
            resolve_runtime_control_endpoint(
                "http://127.0.0.1:7711".to_string(),
                "http://127.0.0.1:7811".to_string()
            ),
            "http://127.0.0.1:7811"
        );
        assert_eq!(
            resolve_runtime_control_endpoint(String::new(), "http://127.0.0.1:7811".to_string()),
            "http://127.0.0.1:7811"
        );
        assert_eq!(
            resolve_runtime_control_endpoint(String::new(), "not-an-endpoint".to_string()),
            ""
        );
    }

    #[test]
    fn native_runtime_readiness_requires_trusted_endpoint() {
        let token = "abcdefghijklmnopqrstuvwxyzABCDEF_0123456789-";
        assert!(!xorein_control_ready_with_token("", token));
        assert!(!xorein_control_ready_with_token("   ", token));
        assert!(!xorein_control_ready_with_token("127.0.0.1:9", token));
        assert!(!xorein_control_ready_with_token("127.0.0.1:9", ""));
    }

    #[test]
    fn native_runtime_readiness_accepts_loopback_with_valid_token() {
        let token = "abcdefghijklmnopqrstuvwxyzABCDEF_0123456789-";
        let endpoint = spawn_control_probe_server(token);
        assert!(xorein_control_ready_with_token(&endpoint, token));

        let endpoint = spawn_control_probe_server(token);
        assert!(!xorein_control_ready_with_token(
            &endpoint,
            "abcdefghijklmnopqrstuvwxyzABCDEF_0123456789_"
        ));
    }

    #[test]
    fn trusted_data_dir_allows_missing_paths() {
        let path = test_path("missing-data-dir");
        assert!(is_trusted_data_dir_for_reads(&path));
    }

    #[test]
    fn trusted_data_dir_accepts_private_directories() {
        let path = test_path("private-data-dir");
        std::fs::create_dir(&path).expect("create private data dir");
        set_private_directory_permissions(&path);
        assert!(is_trusted_data_dir_for_reads(&path));
        std::fs::remove_dir(path).ok();
    }

    #[test]
    fn trusted_data_dir_rejects_files() {
        let path = test_path("file-data-dir");
        std::fs::write(&path, "not a directory").expect("write data dir file");
        set_private_permissions(&path);
        assert!(!is_trusted_data_dir_for_reads(&path));
        std::fs::remove_file(path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn trusted_data_dir_rejects_group_or_world_accessible_directories() {
        use std::os::unix::fs::PermissionsExt;

        let path = test_path("public-data-dir");
        std::fs::create_dir(&path).expect("create public data dir");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("set public directory permissions");
        assert!(!is_trusted_data_dir_for_reads(&path));
        std::fs::remove_dir(path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn trusted_data_dir_rejects_symlinks() {
        let target = test_path("data-dir-target");
        let link = test_path("data-dir-link");
        std::fs::create_dir(&target).expect("create target data dir");
        set_private_directory_permissions(&target);
        std::os::unix::fs::symlink(&target, &link).expect("create data dir symlink");
        assert!(!is_trusted_data_dir_for_reads(&link));
        std::fs::remove_file(link).ok();
        std::fs::remove_dir(target).ok();
    }

    #[test]
    fn read_regular_utf8_file_reads_regular_files() {
        let path = test_path("regular-control-file");
        std::fs::write(&path, "127.0.0.1:7711\n").expect("write test file");
        set_private_permissions(&path);
        assert_eq!(
            read_regular_utf8_file(&path).as_deref(),
            Some("127.0.0.1:7711\n")
        );
        std::fs::remove_file(path).ok();
    }

    #[cfg(unix)]
    fn set_private_permissions(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .expect("set private permissions");
    }

    #[cfg(not(unix))]
    fn set_private_permissions(_path: &std::path::Path) {}

    #[cfg(unix)]
    fn set_private_directory_permissions(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("set private directory permissions");
    }

    #[cfg(not(unix))]
    fn set_private_directory_permissions(_path: &std::path::Path) {}

    #[cfg(unix)]
    #[test]
    fn read_regular_utf8_file_rejects_group_or_world_readable_files() {
        use std::os::unix::fs::PermissionsExt;

        let path = test_path("public-control-file");
        std::fs::write(&path, "127.0.0.1:7711\n").expect("write test file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("set public permissions");
        assert_eq!(read_regular_utf8_file(&path), None);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn read_regular_utf8_file_rejects_directories() {
        let path = test_path("control-file-dir");
        std::fs::create_dir(&path).expect("create test dir");
        assert_eq!(read_regular_utf8_file(&path), None);
        std::fs::remove_dir(path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn read_regular_utf8_file_rejects_symlinks() {
        let target = test_path("control-file-target");
        let link = test_path("control-file-link");
        std::fs::write(&target, "127.0.0.1:7711\n").expect("write target file");
        set_private_permissions(&target);
        std::os::unix::fs::symlink(&target, &link).expect("create test symlink");
        assert_eq!(read_regular_utf8_file(&link), None);
        std::fs::remove_file(link).ok();
        std::fs::remove_file(target).ok();
    }
}
