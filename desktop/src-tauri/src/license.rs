use crate::state::{device_id, AppStore};
use reqwest::Client;
use serde_json::json;
use tauri::AppHandle;

fn license_base_url() -> String {
    std::env::var("LICENSE_API_URL").unwrap_or_else(|_| "http://localhost:8788".into())
}

async fn client() -> Client {
    Client::builder()
        .user_agent("calculated-live-desktop/0.1.0")
        .build()
        .expect("http client")
}

pub async fn request_login(_app: &AppHandle, email: &str) -> Result<serde_json::Value, String> {
    let res = client()
        .await
        .post(format!("{}/license/login", license_base_url()))
        .json(&json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("login failed").to_string());
    }
    Ok(body)
}

pub async fn create_checkout(_app: &AppHandle, email: &str) -> Result<(), String> {
    let res = client()
        .await
        .post(format!("{}/purchase/checkout", license_base_url()))
        .json(&json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("checkout failed").to_string());
    }
    let url = body["url"].as_str().ok_or("missing checkout url")?;
    open::that(url).map_err(|e| e.to_string())
}

fn persist_license(app: &AppHandle, email: &str, license_token: &str) -> Result<(), String> {
    let mut store = AppStore::load(app);
    store.license_email = Some(email.to_string());
    store.license_token = Some(license_token.to_string());
    store.save(app)
}

pub async fn verify_login(app: &AppHandle, token: &str) -> Result<(), String> {
    let device = device_id();
    let res = client()
        .await
        .post(format!("{}/license/verify-login", license_base_url()))
        .json(&json!({ "token": token, "deviceId": device }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if status.as_u16() == 409 {
        return Err("Another device is active. Use Transfer on the Live screen or wait 72h.".into());
    }
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("verify failed").to_string());
    }
    let license_token = body["token"].as_str().ok_or("missing token")?;
    let email = body["email"].as_str().ok_or("missing email")?;
    persist_license(app, email, license_token)
}

pub async fn dev_login(app: &AppHandle, email: &str) -> Result<(), String> {
    let device = device_id();
    let res = client()
        .await
        .post(format!("{}/license/dev-login", license_base_url()))
        .json(&json!({ "email": email, "deviceId": device }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("dev login failed").to_string());
    }
    let license_token = body["token"].as_str().ok_or("missing token")?;
    let email = body["email"].as_str().ok_or("missing email")?;
    persist_license(app, email, license_token)
}

fn license_token(app: &AppHandle) -> Option<String> {
    AppStore::load(app).license_token.filter(|s| !s.is_empty())
}

async fn refresh_token(app: &AppHandle, path: &str) -> Result<String, String> {
    let token = license_token(app).ok_or("not signed in")?;
    let device = device_id();
    let res = client()
        .await
        .post(format!("{}{}", license_base_url(), path))
        .header("Authorization", format!("Bearer {}", token))
        .json(&json!({ "deviceId": device }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("license error").to_string());
    }
    let new_token = body["token"].as_str().ok_or("missing token")?.to_string();
    let email = AppStore::load(app).license_email.unwrap_or_default();
    persist_license(app, &email, &new_token)?;
    Ok(new_token)
}

pub async fn heartbeat(app: &AppHandle) -> Result<(), String> {
    if license_token(app).is_none() {
        return Ok(());
    }
    let _ = refresh_token(app, "/license/heartbeat").await?;
    Ok(())
}

pub async fn transfer(app: &AppHandle) -> Result<(), String> {
    let _ = refresh_token(app, "/license/transfer").await?;
    Ok(())
}

pub async fn logout(app: &AppHandle) -> Result<(), String> {
    if let Some(token) = license_token(app) {
        let device = device_id();
        let _ = client()
            .await
            .post(format!("{}/license/logout", license_base_url()))
            .header("Authorization", format!("Bearer {}", token))
            .json(&json!({ "deviceId": device }))
            .send()
            .await;
    }
    let mut store = AppStore::load(app);
    store.license_email = None;
    store.license_token = None;
    store.save(app)
}

pub fn require_license(app: &AppHandle) -> Result<(), String> {
    let store = AppStore::load(app);
    if store.license_email.is_none() || license_token(app).is_none() {
        return Err("Sign in with a paid license first".into());
    }
    Ok(())
}
