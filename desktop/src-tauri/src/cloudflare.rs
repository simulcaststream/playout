use crate::license::require_license;
use crate::state::AppStore;
use reqwest::Client;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const WORKER_NAME: &str = "calculated-live-manifest";
const BUCKET_NAME: &str = "calculated-live-segments";
const KV_TITLE: &str = "LIVE_EVENT_RECORDS";

fn http() -> Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent("calculated-live-desktop/0.1.0")
                .pool_max_idle_per_host(16)
                .timeout(Duration::from_secs(180))
                .build()
                .expect("http client")
        })
        .clone()
}

fn api_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        "Authorization",
        format!("Bearer {}", token).parse().unwrap(),
    );
    h.insert("Content-Type", "application/json".parse().unwrap());
    h
}

pub async fn resolve_account_id(api_token: &str) -> Result<String, String> {
    let accounts = http()
        .get("https://api.cloudflare.com/client/v4/accounts")
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let acc_body: Value = accounts.json().await.map_err(|e| e.to_string())?;
    if acc_body["success"].as_bool() != Some(true) {
        return Err(acc_body["errors"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e["message"].as_str())
            .unwrap_or("could not list Cloudflare accounts")
            .to_string());
    }
    acc_body["result"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|a| a["id"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no Cloudflare account found for this token".into())
}

pub async fn verify_token(
    app: &AppHandle,
    api_token: &str,
    account_id: Option<&str>,
    access_key_id: Option<&str>,
    secret_access_key: Option<&str>,
    s3_endpoint: Option<&str>,
) -> Result<Value, String> {
    let pasted_account = account_id.map(str::trim).filter(|s| !s.is_empty());
    let from_endpoint = s3_endpoint.and_then(account_id_from_s3_endpoint);
    let account_id = match (pasted_account, from_endpoint.as_deref()) {
        (Some(id), _) => id.to_string(),
        (None, Some(id)) => id.to_string(),
        (None, None) => resolve_account_id(api_token).await?,
    };
    let token_status = confirm_token(api_token, &account_id).await?;

    persist_cf_session(app, api_token, Some(&account_id))?;
    set_cf_auth_mode(app, "api_token")?;

    let access = access_key_id.map(str::trim).filter(|s| !s.is_empty());
    let secret = secret_access_key.map(str::trim).filter(|s| !s.is_empty());
    let (s3_id, s3_secret) = match (access, secret) {
        (Some(id), Some(secret)) => (id.to_string(), secret.to_string()),
        (None, None) => {
            return Err(
                "Paste Access Key ID and Secret Access Key from the token screen.".into(),
            )
        }
        _ => {
            return Err("Paste both Access Key ID and Secret Access Key from the token screen.".into())
        }
    };
    crate::r2_s3::persist_creds(app, &s3_id, &s3_secret)?;

    Ok(json!({
        "accountId": account_id,
        "tokenStatus": token_status,
        "authMode": "api_token",
        "hasR2S3Keys": true
    }))
}

fn account_id_from_s3_endpoint(endpoint: &str) -> Option<String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let host = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = host.split('/').next().unwrap_or(host);
    let rest = host.strip_suffix(".r2.cloudflarestorage.com")?;
    let account = rest.split('.').next()?.trim();
    if account.is_empty() {
        None
    } else {
        Some(account.to_string())
    }
}

async fn confirm_token(api_token: &str, account_id: &str) -> Result<String, String> {
    let account = http()
        .get(format!(
            "https://api.cloudflare.com/client/v4/accounts/{account_id}"
        ))
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: Value = account.json().await.map_err(|e| e.to_string())?;
    if body["success"].as_bool() == Some(true) {
        return Ok("active".into());
    }

    let verify = http()
        .get("https://api.cloudflare.com/client/v4/user/tokens/verify")
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let verify_body: Value = verify.json().await.map_err(|e| e.to_string())?;
    if verify_body["success"].as_bool() == Some(true) {
        return Ok(verify_body["result"]["status"]
            .as_str()
            .unwrap_or("active")
            .to_string());
    }

    Err(body["errors"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|e| e["message"].as_str())
        .or_else(|| {
            verify_body["errors"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|e| e["message"].as_str())
        })
        .unwrap_or("Cloudflare API token was rejected. Paste a new token.")
        .to_string())
}

pub fn persist_cf_session(app: &AppHandle, token: &str, account_id: Option<&str>) -> Result<(), String> {
    let mut store = AppStore::load(app);
    store.cf_api_token = Some(token.to_string());
    store.cf_refresh_token = None;
    if let Some(id) = account_id {
        store.account_id = Some(id.to_string());
    }
    store.save(app)
}

pub fn set_cf_auth_mode(app: &AppHandle, mode: &str) -> Result<(), String> {
    let mut store = AppStore::load(app);
    store.cf_auth_mode = Some(mode.to_string());
    if mode == "api_token" {
        store.cf_refresh_token = None;
    }
    store.save(app)
}

async fn ensure_r2_bucket(token: &str, account_id: &str) -> Result<(), String> {
    let client = http();
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/r2/buckets",
        account_id
    );
    let check = client
        .get(format!("{}/{}", url, BUCKET_NAME))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if check.status().is_success() {
        return Ok(());
    }
    let res = client
        .post(&url)
        .headers(api_headers(token))
        .json(&json!({ "name": BUCKET_NAME }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let body: Value = res.json().await.unwrap_or(json!({}));
        // bucket may already exist under different error shape
        let msg = body["errors"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e["message"].as_str())
            .unwrap_or("failed to create R2 bucket");
        if !msg.contains("already exists") {
            return Err(msg.to_string());
        }
    }
    Ok(())
}

async fn ensure_kv_namespace(token: &str, account_id: &str) -> Result<String, String> {
    let client = http();
    let list_url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces",
        account_id
    );
    let list = client
        .get(&list_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let list_body: Value = list.json().await.map_err(|e| e.to_string())?;
    if let Some(ns) = list_body["result"].as_array().and_then(|arr| {
        arr.iter()
            .find(|n| n["title"].as_str() == Some(KV_TITLE))
            .and_then(|n| n["id"].as_str())
    }) {
        return Ok(ns.to_string());
    }
    let res = client
        .post(&list_url)
        .headers(api_headers(token))
        .json(&json!({ "title": KV_TITLE }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if body["success"].as_bool() != Some(true) {
        return Err(body["errors"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e["message"].as_str())
            .unwrap_or("failed to create KV namespace")
            .to_string());
    }
    Ok(body["result"]["id"]
        .as_str()
        .ok_or("missing namespace id")?
        .to_string())
}

fn worker_bundle_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;
    let bundled = resource_dir.join("worker").join("index.js");
    if bundled.exists() {
        return Ok(bundled);
    }
    // Dev fallback: repo root relative to cwd
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("worker")
        .join("index.js");
    if dev.exists() {
        return Ok(dev);
    }
    Err("worker bundle not found — run pnpm build:worker-bundle".into())
}

async fn deploy_worker(
    token: &str,
    account_id: &str,
    kv_namespace_id: &str,
    worker_script: &str,
) -> Result<(), String> {
    let metadata = json!({
        "main_module": "index.js",
        "bindings": [
            {
                "type": "kv_namespace",
                "name": "LIVE_EVENT_RECORDS",
                "namespace_id": kv_namespace_id
            },
            {
                "type": "r2_bucket",
                "name": "SEGMENTS",
                "bucket_name": BUCKET_NAME
            }
        ],
        "compatibility_date": "2026-07-03",
        "compatibility_flags": ["nodejs_compat"]
    });

    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}",
        account_id, WORKER_NAME
    );

    let part_metadata = reqwest::multipart::Part::text(metadata.to_string())
        .mime_str("application/json")
        .map_err(|e| e.to_string())?;
    let part_script = reqwest::multipart::Part::text(worker_script.to_string())
        .file_name("index.js")
        .mime_str("application/javascript+module")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .part("metadata", part_metadata)
        .part("index.js", part_script);

    let res = http()
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if body["success"].as_bool() != Some(true) {
        let msg = body["errors"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e["message"].as_str())
            .unwrap_or("worker deploy failed");
        return Err(map_auth_error(msg));
    }

    // Enable workers.dev subdomain route
    let route_url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/subdomain",
        account_id, WORKER_NAME
    );
    let _ = http()
        .post(&route_url)
        .headers(api_headers(token))
        .json(&json!({ "enabled": true }))
        .send()
        .await;

    Ok(())
}

async fn worker_origin(token: &str, account_id: &str) -> Result<String, String> {
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/workers/subdomain",
        account_id
    );
    let res = http()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let subdomain = body["result"]["subdomain"]
        .as_str()
        .ok_or("could not resolve workers.dev subdomain")?;
    Ok(format!("https://{}.{}.workers.dev", WORKER_NAME, subdomain))
}

const REAUTH_MESSAGE: &str =
    "Cloudflare API token was rejected. Paste a new token on API keys & uploads.";

fn map_auth_error(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("authentication")
        || lower.contains("unauthorized")
        || lower.contains("invalid api token")
        || lower.contains("invalid access token")
    {
        REAUTH_MESSAGE.to_string()
    } else {
        msg.to_string()
    }
}

pub async fn provision(
    app: &AppHandle,
    token_override: Option<&str>,
    account_id: Option<&str>,
) -> Result<Value, String> {
    require_license(app)?;
    let api_token = match token_override {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => ensure_token(app).await?,
    };
    let account_id = match account_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => resolve_account_id(&api_token).await?,
    };
    persist_cf_session(app, &api_token, Some(&account_id))?;

    ensure_r2_bucket(&api_token, &account_id).await?;
    let kv_id = ensure_kv_namespace(&api_token, &account_id).await?;

    let bundle_path = worker_bundle_path(app)?;
    let script = fs::read_to_string(&bundle_path).map_err(|e| e.to_string())?;
    deploy_worker(&api_token, &account_id, &kv_id, &script).await?;

    let origin = worker_origin(&api_token, &account_id).await?;

    let mut store = AppStore::load(app);
    store.account_id = Some(account_id.clone());
    store.worker_origin = Some(origin.clone());
    store.bucket_name = Some(BUCKET_NAME.to_string());
    store.kv_namespace_id = Some(kv_id.clone());
    store.save(app)?;

    Ok(json!({
        "workerOrigin": origin,
        "bucketName": BUCKET_NAME,
        "kvNamespaceId": kv_id
    }))
}

pub async fn put_kv_value(
    token: &str,
    account_id: &str,
    namespace_id: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let encoded_key = urlencoding::encode(key);
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces/{}/values/{}",
        account_id, namespace_id, encoded_key
    );
    let res = http()
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "text/plain")
        .body(value.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("KV put failed: {}", map_auth_error(&body)));
    }
    Ok(())
}

pub async fn delete_kv_value(
    token: &str,
    account_id: &str,
    namespace_id: &str,
    key: &str,
) -> Result<(), String> {
    let encoded_key = urlencoding::encode(key);
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces/{}/values/{}",
        account_id, namespace_id, encoded_key
    );
    let res = http()
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    let body = res.text().await.unwrap_or_default();
    Err(format!("KV delete failed: {}", map_auth_error(&body)))
}

const REQUIRED_BINDINGS: [&str; 2] = ["LIVE_EVENT_RECORDS", "SEGMENTS"];

fn binding_ok(bindings: &[Value], name: &str) -> bool {
    bindings.iter().any(|b| {
        let n = b["name"].as_str().unwrap_or("");
        let ty = b["type"].as_str().unwrap_or("");
        n == name
            && match name {
                "LIVE_EVENT_RECORDS" => ty == "kv_namespace",
                "SEGMENTS" => ty == "r2_bucket",
                _ => true,
            }
    })
}

async fn fetch_worker_bindings(token: &str, account_id: &str) -> Result<Option<Vec<Value>>, String> {
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/settings",
        account_id, WORKER_NAME
    );
    let res = http()
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if body["success"].as_bool() == Some(true) {
        if let Some(arr) = body["result"]["bindings"].as_array() {
            return Ok(Some(arr.clone()));
        }
        return Ok(Some(Vec::new()));
    }
    if status.as_u16() == 404 || body["errors"].as_array().is_some_and(|e| {
        e.iter()
            .any(|err| err["code"].as_u64() == Some(10007) || err["message"].as_str().unwrap_or("").to_lowercase().contains("not found"))
    }) {
        return Ok(None);
    }
    let msg = body["errors"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|e| e["message"].as_str())
        .unwrap_or("could not read Worker settings");
    Err(map_auth_error(msg))
}

pub async fn check_worker_bindings(app: &AppHandle) -> Result<Value, String> {
    require_license(app)?;
    let token = ensure_token(app).await?;
    let store = AppStore::load(app);
    let account_id = match store.account_id.clone().filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => resolve_account_id(&token).await?,
    };

    let bindings = fetch_worker_bindings(&token, &account_id).await?;
    let Some(bindings) = bindings else {
        return Ok(json!({
            "ok": false,
            "exists": false,
            "missing": REQUIRED_BINDINGS,
            "present": [],
            "workerOrigin": serde_json::Value::Null,
            "message": "Playback Worker is not deployed. Redeploy, then Recheck."
        }));
    };

    let present: Vec<&str> = REQUIRED_BINDINGS
        .iter()
        .copied()
        .filter(|name| binding_ok(&bindings, name))
        .collect();
    let missing: Vec<&str> = REQUIRED_BINDINGS
        .iter()
        .copied()
        .filter(|name| !binding_ok(&bindings, name))
        .collect();

    let kv_id = bindings.iter().find_map(|b| {
        if b["name"].as_str() == Some("LIVE_EVENT_RECORDS") {
            b["namespace_id"].as_str().map(|s| s.to_string())
        } else {
            None
        }
    });
    let origin = worker_origin(&token, &account_id).await.ok();

    let mut store = AppStore::load(app);
    store.account_id = Some(account_id);
    store.bucket_name = Some(BUCKET_NAME.to_string());
    if let Some(id) = kv_id {
        store.kv_namespace_id = Some(id);
    }
    if let Some(o) = origin.clone() {
        store.worker_origin = Some(o);
    }
    store.save(app)?;

    let ok = missing.is_empty();
    Ok(json!({
        "ok": ok,
        "exists": true,
        "missing": missing,
        "present": present,
        "workerOrigin": origin,
        "message": if ok {
            "Worker bindings OK"
        } else {
            "Worker bindings missing. Redeploy, then Recheck."
        }
    }))
}

pub async fn redeploy_worker(app: &AppHandle) -> Result<Value, String> {
    provision(app, None, None).await
}

pub async fn ensure_token(app: &AppHandle) -> Result<String, String> {
    api_token(app)
}

pub fn api_token(app: &AppHandle) -> Result<String, String> {
    AppStore::load(app)
        .cf_api_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Paste a Cloudflare API token on API keys & uploads.".into())
}

pub fn load_cf_config(app: &AppHandle) -> Result<(String, String, String, String), String> {
    let store = AppStore::load(app);
    let token = api_token(app)?;
    let account_id = store.account_id.ok_or("account id missing")?;
    let kv_id = store.kv_namespace_id.ok_or("KV namespace missing — provision first")?;
    let bucket = store.bucket_name.unwrap_or_else(|| BUCKET_NAME.to_string());
    Ok((token, account_id, kv_id, bucket))
}
