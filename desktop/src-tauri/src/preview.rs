use crate::state::AppStore;
use std::fs;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const PREVIEW_PORT: u16 = 18765;

pub fn start() {
    tauri::async_runtime::spawn(async {
        if let Err(e) = run().await {
            eprintln!("preview server: {e}");
        }
    });
}

async fn run() -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", PREVIEW_PORT))
        .await
        .map_err(|e| format!("preview bind {PREVIEW_PORT}: {e}"))?;
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 16_384];
            let Ok(n) = stream.read(&mut buf).await else {
                return;
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let line = req.lines().next().unwrap_or("");
            let path = line.split_whitespace().nth(1).unwrap_or("/");
            let range = req
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                .and_then(|l| l.split(':').nth(1))
                .map(|s| s.trim().to_string());

            if line.starts_with("OPTIONS ") {
                let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nConnection: close\r\n\r\n").await;
                return;
            }

            let head_only = line.starts_with("HEAD ");
            match file_for_preview(path) {
                Some(file) => {
                    let _ = write_file(&mut stream, &file, range.as_deref(), head_only).await;
                }
                None => {
                    let body = b"not found";
                    let resp = format!(
                        "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                }
            }
        });
    }
}

fn file_for_preview(url_path: &str) -> Option<PathBuf> {
    let path = url_path.split('?').next().unwrap_or(url_path);
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") {
        return None;
    }
    let mut parts = trimmed.splitn(2, '/');
    let slug = parts.next()?;
    if !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return None;
    }
    let rest = parts.next().unwrap_or("hls.m3u8");
    let root = AppStore::pack_dir(slug);
    let candidate = root.join(rest);
    let canon = candidate.canonicalize().ok()?;
    let root_canon = root.canonicalize().ok()?;
    if !canon.starts_with(&root_canon) {
        return None;
    }
    if canon.is_file() {
        Some(canon)
    } else {
        None
    }
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("m4s") => "video/iso.segment",
        Some("mp4") => "video/mp4",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

async fn write_file(
    stream: &mut tokio::net::TcpStream,
    path: &std::path::Path,
    range: Option<&str>,
    head_only: bool,
) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let total = bytes.len();
    let ct = content_type(path);
    let (status, start, end) = parse_range(range, total);
    let slice = &bytes[start..=end];
    let headers = if status == 206 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\nAccept-Ranges: bytes\r\nContent-Type: {ct}\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            slice.len()
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\nAccept-Ranges: bytes\r\nContent-Type: {ct}\r\nContent-Length: {total}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        )
    };
    stream.write_all(headers.as_bytes()).await.map_err(|e| e.to_string())?;
    if !head_only {
        stream.write_all(slice).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn parse_range(range: Option<&str>, total: usize) -> (u16, usize, usize) {
    let Some(r) = range else {
        return (200, 0, total.saturating_sub(1));
    };
    let spec = r.strip_prefix("bytes=").unwrap_or(r);
    let mut parts = spec.splitn(2, '-');
    let start = parts.next().unwrap_or("").parse::<usize>().unwrap_or(0);
    let end = parts
        .next()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(total.saturating_sub(1))
        .min(total.saturating_sub(1));
    if start > end || start >= total {
        return (200, 0, total.saturating_sub(1));
    }
    (206, start, end)
}
