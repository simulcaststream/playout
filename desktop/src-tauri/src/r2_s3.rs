//! Direct S3 PUTs to R2. Each segment is an R2 Class A op, not a Worker request.
use crate::state::AppStore;
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;

const BUCKET: &str = "calculated-live-segments";
const REGION: &str = "auto";
const SERVICE: &str = "s3";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct R2S3Creds {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub account_id: String,
}

fn http() -> Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent("calculated-live-desktop/0.1.0")
                .pool_max_idle_per_host(16)
                .timeout(Duration::from_secs(180))
                .build()
                .expect("r2 s3 client")
        })
        .clone()
}

pub fn load_creds(app: &AppHandle) -> Option<R2S3Creds> {
    let store = AppStore::load(app);
    let access_key_id = store.r2_access_key_id.filter(|s| !s.is_empty())?;
    let secret_access_key = store.r2_secret_access_key.filter(|s| !s.is_empty())?;
    let account_id = store.account_id.filter(|s| !s.is_empty())?;
    Some(R2S3Creds {
        access_key_id,
        secret_access_key,
        account_id,
    })
}

pub fn has_creds(app: &AppHandle) -> bool {
    load_creds(app).is_some()
}

pub fn persist_creds(app: &AppHandle, access_key_id: &str, secret_access_key: &str) -> Result<(), String> {
    let id = access_key_id.trim();
    let secret = secret_access_key.trim();
    if id.is_empty() || secret.is_empty() {
        return Err("Access Key ID and Secret Access Key are both required".into());
    }
    let mut store = AppStore::load(app);
    store.r2_access_key_id = Some(id.to_string());
    store.r2_secret_access_key = Some(secret.to_string());
    store.save(app)
}

pub fn clear_creds(app: &AppHandle) -> Result<(), String> {
    let mut store = AppStore::load(app);
    store.r2_access_key_id = None;
    store.r2_secret_access_key = None;
    store.save(app)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn signing_key(secret: &str, date_stamp: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, REGION.as_bytes());
    let k_service = hmac_sha256(&k_region, SERVICE.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

fn authorization(
    creds: &R2S3Creds,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    extra_headers: &[(&str, &str)],
    payload_hash: &str,
    amz_date: &str,
    date_stamp: &str,
    host: &str,
) -> String {
    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), host.to_string()),
        ("x-amz-content-sha256".into(), payload_hash.to_string()),
        ("x-amz-date".into(), amz_date.to_string()),
    ];
    for (k, v) in extra_headers {
        headers.push((k.to_lowercase(), v.to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed_headers: String = headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date_stamp}/{REGION}/{SERVICE}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let sig = hex_encode(&hmac_sha256(&signing_key(&creds.secret_access_key, date_stamp), string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={sig}",
        creds.access_key_id
    )
}

fn endpoint_host(account_id: &str) -> String {
    format!("{account_id}.r2.cloudflarestorage.com")
}

fn object_uri(key: &str) -> String {
    format!("/{BUCKET}/{}", uri_encode(key, false))
}

fn amz_now() -> (String, String) {
    let now = chrono::Utc::now();
    (
        now.format("%Y%m%dT%H%M%SZ").to_string(),
        now.format("%Y%m%d").to_string(),
    )
}

pub async fn put_object(
    creds: &R2S3Creds,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let host = endpoint_host(&creds.account_id);
    let uri = object_uri(key);
    let payload_hash = sha256_hex(&bytes);
    let (amz_date, date_stamp) = amz_now();
    let cache_control = "public, max-age=31536000, immutable";
    let extra = [
        ("cache-control", cache_control),
        ("content-type", content_type),
    ];
    let auth = authorization(
        creds,
        "PUT",
        &uri,
        "",
        &extra,
        &payload_hash,
        &amz_date,
        &date_stamp,
        &host,
    );
    let url = format!("https://{host}{uri}");
    let mut last_err = String::new();
    for attempt in 0..6u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt - 1))).await;
        }
        let res = match http()
            .put(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("Content-Type", content_type)
            .header("Cache-Control", cache_control)
            .body(bytes.clone())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        last_err = format!("{status}: {}", res.text().await.unwrap_or_default());
        if status.as_u16() != 429 && !status.is_server_error() {
            break;
        }
    }
    Err(format!("R2 S3 PUT failed for {key}: {last_err}"))
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(&xml[start..end])
}

fn parse_list_page(xml: &str, prefix: &str) -> (HashMap<String, u64>, Option<String>) {
    let mut objects = HashMap::new();
    let mut rest = xml;
    while let Some(idx) = rest.find("<Contents>") {
        rest = &rest[idx + 10..];
        let Some(end) = rest.find("</Contents>") else {
            break;
        };
        let block = &rest[..end];
        if let (Some(key), Some(size)) = (xml_tag(block, "Key"), xml_tag(block, "Size")) {
            if let Some(rel) = key.strip_prefix(prefix) {
                if let Ok(n) = size.parse::<u64>() {
                    objects.insert(rel.to_string(), n);
                }
            }
        }
        rest = &rest[end + 11..];
    }
    let truncated = xml_tag(xml, "IsTruncated").is_some_and(|v| v.eq_ignore_ascii_case("true"));
    let next = if truncated {
        xml_tag(xml, "NextContinuationToken").map(|s| s.to_string())
    } else {
        None
    };
    (objects, next)
}

pub async fn list_prefix(creds: &R2S3Creds, slug: &str) -> Result<HashMap<String, u64>, String> {
    let prefix = format!("{slug}/");
    let host = endpoint_host(&creds.account_id);
    let canonical_uri = format!("/{BUCKET}");
    let empty_hash = sha256_hex(b"");
    let mut objects = HashMap::new();
    let mut continuation: Option<String> = None;

    loop {
        let (amz_date, date_stamp) = amz_now();
        let mut query_pairs = vec![
            ("list-type".to_string(), "2".to_string()),
            ("prefix".to_string(), prefix.clone()),
        ];
        if let Some(token) = &continuation {
            query_pairs.push(("continuation-token".to_string(), token.clone()));
        }
        query_pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let canonical_query = query_pairs
            .iter()
            .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
            .collect::<Vec<_>>()
            .join("&");
        let auth = authorization(
            creds,
            "GET",
            &canonical_uri,
            &canonical_query,
            &[],
            &empty_hash,
            &amz_date,
            &date_stamp,
            &host,
        );
        let url = format!("https://{host}{canonical_uri}?{canonical_query}");
        let res = http()
            .get(&url)
            .header("Authorization", auth)
            .header("x-amz-content-sha256", &empty_hash)
            .header("x-amz-date", &amz_date)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("R2 S3 list failed for {slug}: {status} {body}"));
        }
        let (page, next) = parse_list_page(&body, &prefix);
        objects.extend(page);
        match next {
            Some(token) => continuation = Some(token),
            None => break,
        }
    }
    Ok(objects)
}

pub async fn upload_object(
    creds: &R2S3Creds,
    slug: &str,
    rel: &str,
    file_path: &PathBuf,
    content_type: &str,
) -> Result<(), String> {
    let bytes = std::fs::read(file_path).map_err(|e| e.to_string())?;
    let key = format!("{slug}/{rel}");
    put_object(creds, &key, bytes, content_type).await
}

pub async fn delete_object(creds: &R2S3Creds, key: &str) -> Result<(), String> {
    let host = endpoint_host(&creds.account_id);
    let uri = object_uri(key);
    let payload_hash = sha256_hex(b"");
    let (amz_date, date_stamp) = amz_now();
    let auth = authorization(
        creds,
        "DELETE",
        &uri,
        "",
        &[],
        &payload_hash,
        &amz_date,
        &date_stamp,
        &host,
    );
    let url = format!("https://{host}{uri}");
    let mut last_err = String::new();
    for attempt in 0..6u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt - 1))).await;
        }
        let res = match http()
            .delete(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let status = res.status();
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        last_err = format!("{status}: {}", res.text().await.unwrap_or_default());
        if status.as_u16() != 429 && !status.is_server_error() {
            break;
        }
    }
    Err(format!("R2 S3 DELETE failed for {key}: {last_err}"))
}

pub async fn copy_object(creds: &R2S3Creds, from_key: &str, to_key: &str) -> Result<(), String> {
    let host = endpoint_host(&creds.account_id);
    let uri = object_uri(to_key);
    let payload_hash = sha256_hex(b"");
    let copy_source = format!("/{BUCKET}/{}", uri_encode(from_key, false));
    let extra = [("x-amz-copy-source", copy_source.as_str())];
    let mut last_err = String::new();
    for attempt in 0..6u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt - 1))).await;
        }
        let (amz_date, date_stamp) = amz_now();
        let auth = authorization(
            creds,
            "PUT",
            &uri,
            "",
            &extra,
            &payload_hash,
            &amz_date,
            &date_stamp,
            &host,
        );
        let url = format!("https://{host}{uri}");
        let res = match http()
            .put(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("x-amz-copy-source", &copy_source)
            .body(Vec::<u8>::new())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        last_err = format!("{status}: {}", res.text().await.unwrap_or_default());
        if status.as_u16() != 429 && !status.is_server_error() {
            break;
        }
    }
    Err(format!("R2 S3 COPY failed for {from_key} -> {to_key}: {last_err}"))
}

pub async fn copy_prefix(creds: &R2S3Creds, from_slug: &str, to_slug: &str) -> Result<u32, String> {
    let objects = list_prefix(creds, from_slug).await?;
    if objects.is_empty() {
        return Ok(0);
    }
    let dest = list_prefix(creds, to_slug).await?;
    if !dest.is_empty() {
        return Err(format!("R2 already has objects under {to_slug}/"));
    }
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let mut set = tokio::task::JoinSet::new();
    for rel in objects.keys() {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let creds = creds.clone();
        let from_key = format!("{from_slug}/{rel}");
        let to_key = format!("{to_slug}/{rel}");
        set.spawn(async move {
            let _permit = permit;
            copy_object(&creds, &from_key, &to_key).await
        });
    }
    while let Some(joined) = set.join_next().await {
        joined.map_err(|e| format!("copy task failed: {e}"))??;
    }
    Ok(objects.len() as u32)
}

pub async fn delete_prefix(creds: &R2S3Creds, slug: &str) -> Result<u32, String> {
    let objects = list_prefix(creds, slug).await?;
    if objects.is_empty() {
        return Ok(0);
    }
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let mut set = tokio::task::JoinSet::new();
    for rel in objects.keys() {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let creds = creds.clone();
        let key = format!("{slug}/{rel}");
        set.spawn(async move {
            let _permit = permit;
            delete_object(&creds, &key).await
        });
    }
    while let Some(joined) = set.join_next().await {
        joined.map_err(|e| format!("delete task failed: {e}"))??;
    }
    Ok(objects.len() as u32)
}
