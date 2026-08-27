mod cloudflare;
mod kv_record;
mod license;
mod pack;
mod preview;
mod r2_s3;
mod state;

use serde::Serialize;
use state::{AppStore, Channel};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    pub license_email: Option<String>,
    pub worker_origin: Option<String>,
    pub account_id: Option<String>,
    pub last_slug: Option<String>,
    pub last_master_url: Option<String>,
    pub preview_base_url: String,
    pub cf_auth_mode: Option<String>,
    pub has_r2_s3_keys: bool,
    pub channels: Vec<Channel>,
}

fn store(app: &tauri::AppHandle) -> AppStore {
    AppStore::load(app)
}

#[tauri::command]
fn get_app_state(app: tauri::AppHandle) -> AppStateDto {
    let s = store(&app);
    AppStateDto {
        license_email: s.license_email.clone(),
        worker_origin: s.worker_origin.clone(),
        account_id: s.account_id.clone(),
        last_slug: s.last_slug.clone(),
        last_master_url: s.last_master_url.clone(),
        preview_base_url: format!("http://127.0.0.1:{}", preview::PREVIEW_PORT),
        cf_auth_mode: s.cf_auth_mode.clone(),
        has_r2_s3_keys: r2_s3::has_creds(&app),
        channels: s.channels.clone(),
    }
}

#[tauri::command]
fn create_draft(app: tauri::AppHandle, preferred: Option<String>) -> Result<Channel, String> {
    pack::create_draft(&app, preferred.as_deref())
}

#[tauri::command]
fn attach_source(app: tauri::AppHandle, slug: String, input_path: String) -> Result<Channel, String> {
    pack::attach_source(&app, &slug, &input_path)
}

#[tauri::command]
fn pick_video_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Video", &["mp4", "mov", "mkv"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn license_request_login(app: tauri::AppHandle, email: String) -> Result<serde_json::Value, String> {
    license::request_login(&app, &email).await
}

#[tauri::command]
async fn license_verify_login(app: tauri::AppHandle, token: String) -> Result<(), String> {
    license::verify_login(&app, &token).await
}

#[tauri::command]
async fn license_dev_login(app: tauri::AppHandle, email: String) -> Result<(), String> {
    license::dev_login(&app, &email).await
}

#[tauri::command]
async fn license_create_checkout(app: tauri::AppHandle, email: String) -> Result<(), String> {
    license::create_checkout(&app, &email).await
}

#[tauri::command]
async fn license_heartbeat(app: tauri::AppHandle) -> Result<(), String> {
    license::heartbeat(&app).await
}

#[tauri::command]
async fn license_transfer(app: tauri::AppHandle) -> Result<(), String> {
    license::transfer(&app).await
}

#[tauri::command]
async fn license_logout(app: tauri::AppHandle) -> Result<(), String> {
    license::logout(&app).await
}

#[tauri::command]
async fn verify_cloudflare_token(
    app: tauri::AppHandle,
    api_token: String,
    account_id: Option<String>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    s3_endpoint: Option<String>,
) -> Result<serde_json::Value, String> {
    cloudflare::verify_token(
        &app,
        &api_token,
        account_id.as_deref(),
        access_key_id.as_deref(),
        secret_access_key.as_deref(),
        s3_endpoint.as_deref(),
    )
    .await
}

#[tauri::command]
fn save_r2_s3_keys(
    app: tauri::AppHandle,
    access_key_id: String,
    secret_access_key: String,
) -> Result<(), String> {
    r2_s3::persist_creds(&app, &access_key_id, &secret_access_key)
}

#[tauri::command]
fn clear_r2_s3_keys(app: tauri::AppHandle) -> Result<(), String> {
    r2_s3::clear_creds(&app)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://dash.cloudflare.com")
        || url.starts_with("https://developers.cloudflare.com"))
    {
        return Err("unsupported url".into());
    }
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_worker_bindings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    cloudflare::check_worker_bindings(&app).await
}

#[tauri::command]
async fn redeploy_worker(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    cloudflare::redeploy_worker(&app).await
}

#[tauri::command]
async fn provision_infrastructure(
    app: tauri::AppHandle,
    api_token: Option<String>,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    cloudflare::provision(
        &app,
        api_token.as_deref(),
        account_id.as_deref(),
    )
    .await
}

#[tauri::command]
async fn pack_local(
    app: tauri::AppHandle,
    input_path: String,
    slug: String,
    segment_duration: u32,
    loop247: bool,
) -> Result<serde_json::Value, String> {
    pack::pack_local(&app, &input_path, &slug, segment_duration, loop247).await
}

#[tauri::command]
async fn deploy_channel(
    app: tauri::AppHandle,
    slug: String,
    scheduled_start: i64,
    loop247: Option<bool>,
) -> Result<serde_json::Value, String> {
    pack::deploy_channel(&app, &slug, scheduled_start, loop247).await
}

#[tauri::command]
async fn update_schedule(
    app: tauri::AppHandle,
    slug: String,
    scheduled_start: i64,
) -> Result<serde_json::Value, String> {
    pack::update_schedule(&app, &slug, scheduled_start).await
}

#[tauri::command]
async fn delete_channel(
    app: tauri::AppHandle,
    slug: String,
    keep_local: bool,
) -> Result<serde_json::Value, String> {
    pack::delete_channel(&app, &slug, keep_local).await
}

#[tauri::command]
async fn rename_channel(
    app: tauri::AppHandle,
    slug: String,
    title: String,
    new_slug: String,
) -> Result<serde_json::Value, String> {
    pack::rename_channel(&app, &slug, &title, &new_slug).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let _ = store(app.handle());
            preview::start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            create_draft,
            attach_source,
            pick_video_file,
            license_request_login,
            license_verify_login,
            license_dev_login,
            license_create_checkout,
            license_heartbeat,
            license_transfer,
            license_logout,
            verify_cloudflare_token,
            save_r2_s3_keys,
            clear_r2_s3_keys,
            open_external_url,
            check_worker_bindings,
            redeploy_worker,
            provision_infrastructure,
            pack_local,
            deploy_channel,
            update_schedule,
            delete_channel,
            rename_channel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
