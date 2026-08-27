use crate::cloudflare::{check_worker_bindings, delete_kv_value, load_cf_config, put_kv_value};
use crate::license::require_license;
use crate::state::{is_valid_slug, slugify, AppStore};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::{Duration, sleep};

const UPLOAD_CONCURRENCY: usize = 8;
const SCHEDULE_BUFFER_SECS: i64 = 60;

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn schedule_is_locked(start: i64, duration_seconds: Option<f64>, now: i64) -> bool {
    if start <= 0 {
        return false;
    }
    match duration_seconds.filter(|d| *d > 0.0).map(|d| d.ceil() as i64) {
        Some(duration) => now >= start && now < start + duration + SCHEDULE_BUFFER_SECS,
        None => now >= start,
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

use std::sync::Mutex;

static ACTIVE_SLUG: Mutex<String> = Mutex::new(String::new());

fn set_active_slug(slug: &str) {
    if let Ok(mut g) = ACTIVE_SLUG.lock() {
        *g = slug.to_string();
    }
}

fn emit_progress(app: &AppHandle, stage: &str, current: u32, total: u32, message: &str) {
    let percent = if total == 0 { 0 } else { (current * 100) / total };
    let slug = ACTIVE_SLUG.lock().map(|g| g.clone()).unwrap_or_default();
    let _ = app.emit(
        "pack-progress",
        json!({
            "slug": slug,
            "stage": stage,
            "current": current,
            "total": total,
            "percent": percent,
            "message": message,
        }),
    );
}

/// Bundled prep scripts (release) or repo prep/ (dev).
fn resolve_prep_root(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let prep = resource_dir.join("prep");
        if prep.join("pack-shaka.sh").exists() {
            return prep;
        }
    }
    let dev = repo_root().join("prep");
    if dev.join("pack-shaka.sh").exists() {
        return dev;
    }
    repo_root().join("prep")
}

fn resolve_pack_script(app: &AppHandle) -> Result<PathBuf, String> {
    let script = resolve_prep_root(app).join("pack-shaka.sh");
    if script.exists() {
        Ok(script)
    } else {
        Err(format!("pack script not found: {}", script.display()))
    }
}

fn bundled_tool_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("python"));
        roots.push(resource_dir.join("shaka-venv"));
    }
    roots.push(repo_root().join(".venv"));
    roots
}

/// Bundled Python+Shaka (release) or repo .venv (dev).
fn resolve_shaka_binary(app: &AppHandle) -> Result<PathBuf, String> {
    for root in bundled_tool_roots(app) {
        let candidate = root.join("bin/shaka-streamer");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(
        "Shaka Streamer not found. For dev: python3 -m venv .venv && .venv/bin/pip install shaka-streamer shaka-streamer-binaries. For release: pnpm build:desktop-resources".into(),
    )
}

fn tool_path_prefix(app: &AppHandle) -> String {
    let mut parts = Vec::new();
    for root in bundled_tool_roots(app) {
        let bin = root.join("bin");
        if bin.is_dir() {
            parts.push(bin.to_string_lossy().into_owned());
        }
    }
    parts.join(":")
}

fn find_ffprobe_in_dir(root: &Path) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(root)
        .max_depth(8)
        .into_iter()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy();
        if entry.file_type().is_file() && name.starts_with("ffprobe") {
            return Some(entry.into_path());
        }
    }
    None
}

fn resolve_ffprobe(app: &AppHandle) -> PathBuf {
    for root in bundled_tool_roots(app) {
        if let Some(p) = find_ffprobe_in_dir(&root) {
            return p;
        }
    }
    PathBuf::from("ffprobe")
}

#[derive(Debug, Clone)]
struct SourceProbe {
    width: u32,
    height: u32,
    video_codec: String,
    audio_channels: u32,
    duration_seconds: Option<f64>,
}

fn is_hevc_codec(codec: &str) -> bool {
    matches!(codec.to_lowercase().as_str(), "hevc" | "h265")
}

fn select_video_codec(video_codec: &str) -> String {
    let base = if is_hevc_codec(video_codec) {
        "h265"
    } else {
        "h264"
    };
    #[cfg(target_os = "macos")]
    {
        format!("hw:{base}")
    }
    #[cfg(not(target_os = "macos"))]
    {
        base.to_string()
    }
}

fn select_resolutions(height: u32) -> Vec<&'static str> {
    const RUNGS: [(&str, u32); 6] = [
        ("360p", 360),
        ("480p", 480),
        ("720p", 720),
        ("1080p", 1080),
        ("1440p", 1440),
        ("2160p", 2160),
    ];
    RUNGS
        .iter()
        .filter(|(_, h)| *h <= height)
        .map(|(label, _)| *label)
        .collect()
}

fn select_audio_layouts(channels: u32) -> Vec<&'static str> {
    if channels >= 6 {
        vec!["stereo", "surround"]
    } else if channels == 1 {
        vec!["mono"]
    } else {
        vec!["stereo"]
    }
}

fn select_audio_codecs(channels: u32) -> Vec<&'static str> {
    if channels >= 6 {
        vec!["aac", "eac3"]
    } else {
        vec!["aac"]
    }
}

fn pipeline_summary(probe: &SourceProbe, resolutions: &[&str], audio_codecs: &[&str]) -> String {
    let codec_label = if is_hevc_codec(&probe.video_codec) {
        "HEVC"
    } else {
        "H.264"
    };
    let res_range = if resolutions.is_empty() {
        "none".to_string()
    } else if resolutions.len() == 1 {
        resolutions[0].to_string()
    } else {
        format!("{}–{}", resolutions[0], resolutions[resolutions.len() - 1])
    };
    let audio = if audio_codecs.len() > 1 {
        "AAC stereo + E-AC-3 5.1"
    } else if probe.audio_channels == 1 {
        "AAC mono"
    } else {
        "AAC stereo"
    };
    format!(
        "Source {}x{} {}, {}ch → {} {}, {}\n",
        probe.width,
        probe.height,
        probe.video_codec,
        probe.audio_channels,
        codec_label,
        res_range,
        audio
    )
}

async fn probe_source(app: &AppHandle, input: &str) -> Result<SourceProbe, String> {
    let out = Command::new(resolve_ffprobe(app))
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            input,
        ])
        .output()
        .await
        .map_err(|e| format!("ffprobe failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let value: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("ffprobe JSON parse failed: {e}"))?;

    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| "ffprobe returned no streams".to_string())?;

    let mut width = 0u32;
    let mut height = 0u32;
    let mut video_codec = String::from("h264");
    let mut audio_channels = 0u32;

    for stream in streams {
        match stream["codec_type"].as_str() {
            Some("video") if width == 0 => {
                width = stream["width"].as_u64().unwrap_or(0) as u32;
                height = stream["height"].as_u64().unwrap_or(0) as u32;
                video_codec = stream["codec_name"]
                    .as_str()
                    .unwrap_or("h264")
                    .to_string();
            }
            Some("audio") => {
                let ch = stream["channels"].as_u64().unwrap_or(0) as u32;
                audio_channels = audio_channels.max(ch);
            }
            _ => {}
        }
    }

    if width == 0 || height == 0 {
        return Err("could not detect video dimensions from source file".into());
    }
    if audio_channels == 0 {
        audio_channels = 2;
    }

    let duration_seconds = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| value["format"]["duration"].as_f64());

    Ok(SourceProbe {
        width,
        height,
        video_codec,
        audio_channels,
        duration_seconds,
    })
}

fn highest_segment_number(dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut max = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("video_") || !name.ends_with(".mp4") || name.contains("_init.") {
            continue;
        }
        let Some((_, rest)) = name.rsplit_once('_') else {
            continue;
        };
        let Some(num) = rest.strip_suffix(".mp4") else {
            continue;
        };
        if let Ok(n) = num.parse::<u32>() {
            max = max.max(n);
        }
    }
    max
}

async fn run_shaka_pack(
    app: &AppHandle,
    input: &str,
    outdir: &Path,
    segment_duration: u32,
    log: &mut String,
) -> Result<(), String> {
    let script = resolve_pack_script(app)?;
    let prep_root = resolve_prep_root(app);
    let shaka_bin = resolve_shaka_binary(app)?;
    let probe = probe_source(app, input).await?;
    let video_codec = select_video_codec(&probe.video_codec);
    let resolutions = select_resolutions(probe.height);
    if resolutions.is_empty() {
        return Err(format!(
            "source height {}p is below minimum ladder rung (360p)",
            probe.height
        ));
    }
    let audio_layouts = select_audio_layouts(probe.audio_channels);
    let audio_codecs = select_audio_codecs(probe.audio_channels);
    let summary = pipeline_summary(&probe, &resolutions, &audio_codecs);
    log.push_str(&summary);

    let estimated = probe
        .duration_seconds
        .map(|d| ((d / f64::from(segment_duration.max(1))).ceil() as u32).max(1))
        .unwrap_or(0);
    let line = format!(
        "Running Shaka Streamer pack -> {}\n  binary: {}\n",
        outdir.display(),
        shaka_bin.display()
    );
    log.push_str(&line);
    emit_progress(
        app,
        "packing",
        0,
        estimated,
        "Encoding segments…",
    );

    let path_prefix = tool_path_prefix(app);
    let path_env = if path_prefix.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        format!("{path_prefix}:{}", std::env::var("PATH").unwrap_or_default())
    };

    let mut child = Command::new("bash")
        .arg(&script)
        .arg(input)
        .arg(outdir)
        .arg(segment_duration.to_string())
        .env("SHAKA_BIN", &shaka_bin)
        .env("PREP_ROOT", &prep_root)
        .env("PATH", &path_env)
        .env("PACK_VIDEO_CODEC", &video_codec)
        .env("PACK_RESOLUTIONS", resolutions.join(","))
        .env("PACK_AUDIO_LAYOUTS", audio_layouts.join(","))
        .env("PACK_AUDIO_CODECS", audio_codecs.join(","))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start shaka pack: {e}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe.take() {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr_pipe.take() {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });

    let status = loop {
        tokio::select! {
            status = child.wait() => {
                break status.map_err(|e| format!("failed to run shaka pack: {e}"));
            }
            _ = sleep(Duration::from_secs(2)) => {
                let current = highest_segment_number(outdir);
                if current > 0 {
                    let total = estimated.max(current);
                    emit_progress(app, "packing", current, total, "Encoding segments…");
                }
            }
        }
    }?;

    let stdout = String::from_utf8_lossy(&stdout_task.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_task.await.unwrap_or_default()).into_owned();
    log.push_str(&stdout);
    if !stderr.is_empty() {
        log.push_str(&stderr);
    }
    if !status.success() {
        return Err(format!(
            "Shaka pack failed (exit {:?})",
            status.code()
        ));
    }
    emit_progress(app, "packing", estimated.max(1), estimated.max(1), "Shaka pack complete");
    Ok(())
}

async fn build_kv_record(
    app: &AppHandle,
    outdir: &Path,
    slug: &str,
    storage_base_url: &str,
    segment_duration: u32,
    loop247: bool,
    scheduled_start: i64,
    log: &mut String,
) -> Result<Value, String> {
    emit_progress(
        app,
        "normalizing",
        0,
        0,
        "Copying segments into cdn/ layout…",
    );
    let record = crate::kv_record::build_kv_record(
        outdir,
        slug,
        storage_base_url,
        segment_duration,
        loop247,
        scheduled_start,
        log,
    )?;
    emit_progress(app, "normalizing", 1, 1, "CDN layout ready");
    Ok(record)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("m4s") => "video/iso.segment",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn collect_cdn_files(cdn_dir: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(cdn_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let file_path = entry.path().to_path_buf();
        let rel = file_path
            .strip_prefix(cdn_dir)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        files.push((file_path, rel));
    }
    Ok(files)
}

async fn upload_cdn_tree(
    app: &AppHandle,
    creds: &crate::r2_s3::R2S3Creds,
    slug: &str,
    cdn_dir: &Path,
    log: &mut String,
) -> Result<u32, String> {
    let files = collect_cdn_files(cdn_dir)?;
    let total = files.len() as u32;
    if total == 0 {
        return Err("cdn/ has no files to upload".into());
    }

    emit_progress(app, "checking", 0, total, "Checking R2 for already-uploaded objects…");
    log.push_str("Uploading via R2 S3 API.\n");
    log.push_str("Checking R2 for objects already uploaded…\n");
    let remote = crate::r2_s3::list_prefix(creds, slug).await?;
    log.push_str(&format!("R2 currently has {} object(s) under {slug}/\n", remote.len()));

    let mut pending = Vec::new();
    let mut skipped = 0u32;
    for (file_path, rel) in files {
        let local_size = fs::metadata(&file_path).map_err(|e| format!("{rel}: {e}"))?.len();
        if remote.get(&rel) == Some(&local_size) {
            skipped += 1;
        } else {
            pending.push((file_path, rel));
        }
    }
    let remaining = pending.len() as u32;
    log.push_str(&format!(
        "Skipping {skipped} matching object(s); uploading {remaining} remaining…\n"
    ));
    emit_progress(
        app,
        "uploading",
        skipped,
        total,
        &format!("{skipped}/{total} already on R2, {remaining} to upload"),
    );

    if remaining == 0 {
        emit_progress(app, "uploading", total, total, "All objects already on R2");
        return Ok(0);
    }

    let semaphore = Arc::new(Semaphore::new(UPLOAD_CONCURRENCY));
    let done = Arc::new(AtomicU32::new(skipped));
    let mut set = tokio::task::JoinSet::new();

    for (file_path, rel) in pending {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let slug = slug.to_string();
        let ct = content_type(&file_path).to_string();
        let app = app.clone();
        let done = done.clone();
        let creds = creds.clone();
        set.spawn(async move {
            let _permit = permit;
            let result = crate::r2_s3::upload_object(&creds, &slug, &rel, &file_path, &ct).await;
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n == total || n % 25 == 0 {
                emit_progress(
                    &app,
                    "uploading",
                    n,
                    total,
                    &format!("Uploading {n}/{total} to R2"),
                );
            }
            result.map_err(|e| format!("{slug}/{rel}: {e}"))
        });
    }

    while let Some(joined) = set.join_next().await {
        joined.map_err(|e| format!("upload task failed: {e}"))??;
    }

    log.push_str(&format!("uploaded {remaining} new object(s); {skipped} already present\n"));
    emit_progress(
        app,
        "uploading",
        total,
        total,
        &format!("Uploaded {remaining} objects ({skipped} skipped)"),
    );
    Ok(remaining)
}

fn shaka_output_ready(outdir: &Path) -> bool {
    outdir.join("hls.m3u8").is_file()
}

fn cdn_ready(outdir: &Path) -> bool {
    let cdn = outdir.join("cdn");
    cdn.is_dir()
        && walkdir::WalkDir::new(&cdn)
            .into_iter()
            .filter_map(|e| e.ok())
            .any(|e| e.file_type().is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("m4s"))
}

fn apply_schedule(record: &mut Value, scheduled_start: i64, loop247: bool, storage_base_url: &str) {
    let replay_mode = if loop247 { "loop" } else { "none" };
    record["scheduledStart"] = json!(scheduled_start);
    record["replayMode"] = json!(replay_mode);
    record["storageBaseUrl"] = json!(storage_base_url);
}

fn storage_base_url_for(slug: &str, worker_origin: Option<&str>) -> String {
    match worker_origin.filter(|s| !s.is_empty()) {
        Some(origin) => format!("{}/v1/assets/{slug}", origin.trim_end_matches('/')),
        None => format!("https://pending.invalid/v1/assets/{slug}"),
    }
}

fn rewrite_kv_record_slug(
    pack_dir: &Path,
    new_slug: &str,
    worker_origin: Option<&str>,
) -> Result<(), String> {
    let path = pack_dir.join("kv-record.json");
    if !path.is_file() {
        return Ok(());
    }
    let mut record: Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    record["slug"] = json!(new_slug);
    record["eventId"] = json!(format!("evt_{new_slug}"));
    let storage = match worker_origin.filter(|s| !s.is_empty()) {
        Some(origin) => format!("{}/v1/assets/{new_slug}", origin.trim_end_matches('/')),
        None => record["storageBaseUrl"]
            .as_str()
            .and_then(|u| u.rfind('/').map(|i| format!("{}{new_slug}", &u[..=i])))
            .unwrap_or_else(|| storage_base_url_for(new_slug, None)),
    };
    record["storageBaseUrl"] = json!(storage);
    fs::write(
        &path,
        serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("could not update kv-record.json: {e}"))?;
    Ok(())
}

fn rollback_pack_rename(old_slug: &str, new_slug: &str, kv_backup: Option<&[u8]>) {
    let new_dir = AppStore::pack_dir(new_slug);
    let old_dir = AppStore::pack_dir(old_slug);
    if new_dir.exists() && !old_dir.exists() {
        let _ = fs::rename(&new_dir, &old_dir);
    }
    if let Some(bytes) = kv_backup {
        let _ = fs::write(old_dir.join("kv-record.json"), bytes);
    }
}

pub async fn pack_local(
    app: &AppHandle,
    input_path: &str,
    slug: &str,
    segment_duration: u32,
    loop247: bool,
) -> Result<Value, String> {
    require_license(app)?;

    if !Path::new(input_path).exists() {
        return Err(format!("input file not found: {}", input_path));
    }
    if !is_valid_slug(slug) {
        return Err("slug must be lowercase alphanumeric with hyphens".into());
    }

    let mut log = String::new();
    set_active_slug(slug);
    emit_progress(app, "starting", 0, 0, "Packing locally…");

    let work_base = AppStore::pack_dir(slug);
    let store = AppStore::load(app);
    let already_ours = store.channels.iter().any(|c| c.slug == slug && c.packed);
    if shaka_output_ready(&work_base) && !already_ours {
        return Err(format!(
            "slug '{slug}' already has packed segments. Use New video so this file gets its own folder."
        ));
    }
    fs::create_dir_all(&work_base).map_err(|e| e.to_string())?;

    if shaka_output_ready(&work_base) {
        log.push_str("Existing Shaka output found — skipping re-encode.\n");
        emit_progress(app, "packing", 1, 1, "Existing segments found — skipping re-encode");
    } else {
        run_shaka_pack(app, input_path, &work_base, segment_duration, &mut log).await?;
    }

    let placeholder_start = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let storage_base_url = format!("https://pending.invalid/v1/assets/{slug}");

    let record = if work_base.join("kv-record.json").is_file() && cdn_ready(&work_base) {
        log.push_str("Existing cdn/ layout — skipping normalize.\n");
        emit_progress(app, "normalizing", 1, 1, "Existing CDN layout found");
        let raw = fs::read_to_string(work_base.join("kv-record.json")).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else {
        build_kv_record(
            app,
            &work_base,
            slug,
            &storage_base_url,
            segment_duration,
            loop247,
            placeholder_start,
            &mut log,
        )
        .await?
    };

    let total_segments = record["totalSegments"].as_u64().unwrap_or(0);
    let duration_seconds = record["durationSeconds"].as_f64().unwrap_or(0.0);

    let mut store = AppStore::load(app);
    let prev = store.channels.iter().find(|c| c.slug == slug).cloned();
    let title = prev
        .as_ref()
        .and_then(|c| c.title.clone())
        .or_else(|| {
            Path::new(input_path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        });
    store.upsert_channel(crate::state::Channel {
        slug: slug.to_string(),
        title,
        input_path: Some(input_path.to_string()),
        packed: true,
        deployed: prev.as_ref().map(|c| c.deployed).unwrap_or(false),
        loop247,
        segment_duration,
        total_segments: Some(total_segments),
        duration_seconds: Some(duration_seconds),
        scheduled_start: prev.as_ref().and_then(|c| c.scheduled_start),
        master_url: prev.as_ref().and_then(|c| c.master_url.clone()),
    });
    store.save(app)?;

    emit_progress(app, "done", 1, 1, "Local pack complete");
    Ok(json!({
        "slug": slug,
        "totalSegments": total_segments,
        "durationSeconds": duration_seconds,
        "log": log
    }))
}

pub async fn deploy_channel(
    app: &AppHandle,
    slug: &str,
    scheduled_start: i64,
    loop247: Option<bool>,
) -> Result<Value, String> {
    require_license(app)?;
    if !is_valid_slug(slug) {
        return Err("slug must be lowercase alphanumeric with hyphens".into());
    }
    if scheduled_start <= 0 {
        return Err("go-live date/time is required".into());
    }

    let work_base = AppStore::pack_dir(slug);
    if !cdn_ready(&work_base) {
        return Err("Pack this channel locally first (step 1)".into());
    }

    crate::cloudflare::ensure_token(app).await?;
    let creds = crate::r2_s3::load_creds(app).ok_or_else(|| {
        "Save Cloudflare keys on API keys & uploads. Uploads are disabled until then.".to_string()
    })?;

    let mut log = String::new();
    set_active_slug(slug);
    emit_progress(app, "starting", 0, 0, "Uploading to Cloudflare…");

    let bindings = check_worker_bindings(app).await?;
    if bindings["ok"].as_bool() != Some(true) {
        return Err(
            bindings["message"]
                .as_str()
                .unwrap_or("Worker bindings missing. Redeploy the Worker, then Recheck.")
                .to_string(),
        );
    }

    let store = AppStore::load(app);
    let worker_origin = store
        .worker_origin
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Worker origin missing. Recheck bindings or Redeploy the Worker.".to_string())?;

    let already_deployed = store
        .channels
        .iter()
        .find(|c| c.slug == slug)
        .map(|c| c.deployed)
        .unwrap_or(false);
    let mut scheduled_start = scheduled_start;
    if already_deployed {
        let ch = store.channels.iter().find(|c| c.slug == slug);
        let start = ch.and_then(|c| c.scheduled_start).unwrap_or(0);
        let duration = ch.and_then(|c| c.duration_seconds);
        if schedule_is_locked(start, duration, unix_now()) {
            scheduled_start = start;
            log.push_str("Start time is locked — keeping current go-live and rewriting the live record.\n");
        }
    }
    let loop_flag = loop247.unwrap_or_else(|| {
        store
            .channels
            .iter()
            .find(|c| c.slug == slug)
            .map(|c| c.loop247)
            .unwrap_or(true)
    });

    let kv_path = work_base.join("kv-record.json");
    let mut record: Value = if kv_path.is_file() {
        serde_json::from_str(&fs::read_to_string(&kv_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        return Err("kv-record.json missing — pack locally first".into());
    };

    let storage_base_url = format!("{}/v1/assets/{}", worker_origin.trim_end_matches('/'), slug);
    let master_url = format!(
        "{}/v1/events/{}/master.m3u8",
        worker_origin.trim_end_matches('/'),
        slug
    );
    apply_schedule(&mut record, scheduled_start, loop_flag, &storage_base_url);
    fs::write(
        &kv_path,
        serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let cdn_dir = work_base.join("cdn");
    let uploaded = upload_cdn_tree(app, &creds, slug, &cdn_dir, &mut log).await?;

    emit_progress(app, "kv", 0, 1, "Writing KV event record…");
    crate::cloudflare::ensure_token(app).await?;
    let (token, account_id, kv_id, _) = load_cf_config(app)?;
    put_kv_value(
        &token,
        &account_id,
        &kv_id,
        slug,
        &serde_json::to_string(&record).map_err(|e| e.to_string())?,
    )
    .await?;
    log.push_str(&format!("KV record written for slug {slug}\n"));

    let total_segments = record["totalSegments"].as_u64();
    let duration_seconds = record["durationSeconds"].as_f64();

    let mut store = AppStore::load(app);
    let prev = store.channels.iter().find(|c| c.slug == slug).cloned();
    store.upsert_channel(crate::state::Channel {
        slug: slug.to_string(),
        title: prev.as_ref().and_then(|c| c.title.clone()),
        input_path: prev.as_ref().and_then(|c| c.input_path.clone()),
        packed: true,
        deployed: true,
        loop247: loop_flag,
        segment_duration: prev.as_ref().map(|c| c.segment_duration).unwrap_or(4),
        total_segments,
        duration_seconds,
        scheduled_start: Some(scheduled_start),
        master_url: Some(master_url.clone()),
    });
    store.last_slug = Some(slug.to_string());
    store.last_master_url = Some(master_url.clone());
    store.save(app)?;

    emit_progress(app, "done", 1, 1, "Deploy complete");
    Ok(json!({
        "masterUrl": master_url,
        "uploadedObjects": uploaded,
        "log": log
    }))
}

pub async fn update_schedule(app: &AppHandle, slug: &str, scheduled_start: i64) -> Result<Value, String> {
    require_license(app)?;
    if scheduled_start <= 0 {
        return Err("go-live date/time is required".into());
    }
    let mut store = AppStore::load(app);
    let ch = store
        .channel_mut(slug)
        .ok_or_else(|| "channel not found".to_string())?;
    if !ch.deployed {
        return Err("Deploy this channel first".into());
    }
    let current_start = ch.scheduled_start.unwrap_or(0);
    let duration = ch.duration_seconds;
    if schedule_is_locked(current_start, duration, unix_now()) {
        return Err(
            "Start time is locked until this playthrough finishes (start + duration + 1 minute)."
                .into(),
        );
    }
    ch.scheduled_start = Some(scheduled_start);
    let loop247 = ch.loop247;
    let master_url = ch.master_url.clone();
    store.save(app)?;

    let work_base = AppStore::pack_dir(slug);
    let kv_path = work_base.join("kv-record.json");
    let mut record: Value = serde_json::from_str(
        &fs::read_to_string(&kv_path).map_err(|_| "local kv-record.json missing".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let storage_base_url = record["storageBaseUrl"]
        .as_str()
        .unwrap_or("")
        .to_string();
    apply_schedule(&mut record, scheduled_start, loop247, &storage_base_url);
    fs::write(
        &kv_path,
        serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    crate::cloudflare::ensure_token(app).await?;
    let (token, account_id, kv_id, _) = load_cf_config(app)?;
    let kv_raw = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    put_kv_value(&token, &account_id, &kv_id, slug, &kv_raw).await?;

    Ok(json!({
        "slug": slug,
        "scheduledStart": scheduled_start,
        "masterUrl": master_url
    }))
}

pub fn attach_source(app: &AppHandle, slug: &str, input_path: &str) -> Result<crate::state::Channel, String> {
    if !Path::new(input_path).exists() {
        return Err(format!("input file not found: {}", input_path));
    }
    let mut store = AppStore::load(app);
    let existing = store.channels.iter().find(|c| c.slug == slug).cloned();
    let packed = existing.as_ref().map(|c| c.packed).unwrap_or(false);
    let stem = Path::new(input_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video".into());
    let new_slug = if packed {
        slug.to_string()
    } else {
        store.channels.retain(|c| c.slug != slug);
        store.allocate_slug(&stem)
    };
    let mut ch = existing.unwrap_or(crate::state::Channel {
        slug: new_slug.clone(),
        title: Some(stem.clone()),
        input_path: None,
        packed: false,
        deployed: false,
        loop247: true,
        segment_duration: 4,
        total_segments: None,
        duration_seconds: None,
        scheduled_start: None,
        master_url: None,
    });
    ch.slug = new_slug;
    ch.input_path = Some(input_path.to_string());
    if !packed {
        ch.title = Some(stem);
        ch.packed = false;
        ch.deployed = false;
    }
    store.upsert_channel(ch.clone());
    store.save(app)?;
    Ok(ch)
}

pub fn create_draft(app: &AppHandle, preferred: Option<&str>) -> Result<crate::state::Channel, String> {
    let mut store = AppStore::load(app);
    let slug = store.allocate_slug(preferred.unwrap_or("video"));
    let title = preferred
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("New video")
        .to_string();
    let ch = crate::state::Channel {
        slug,
        title: Some(title),
        input_path: None,
        packed: false,
        deployed: false,
        loop247: true,
        segment_duration: 4,
        total_segments: None,
        duration_seconds: None,
        scheduled_start: None,
        master_url: None,
    };
    store.upsert_channel(ch.clone());
    store.save(app)?;
    Ok(ch)
}

pub async fn delete_channel(app: &AppHandle, slug: &str, keep_local: bool) -> Result<Value, String> {
    require_license(app)?;
    if !is_valid_slug(slug) {
        return Err("slug must be lowercase alphanumeric with hyphens".into());
    }

    let store = AppStore::load(app);
    let channel = store.channels.iter().find(|c| c.slug == slug).cloned();
    let remote_required = channel
        .as_ref()
        .map(|c| c.deployed || c.master_url.as_ref().is_some_and(|u| !u.is_empty()))
        .unwrap_or(false);

    set_active_slug(slug);
    emit_progress(app, "starting", 0, 0, "Removing from Cloudflare…");

    let mut log = String::new();
    let mut deleted_objects = 0u32;

    if remote_required && crate::r2_s3::load_creds(app).is_none() {
        return Err(
            "Save Cloudflare keys on API keys & uploads so this video can be removed from R2 and KV."
                .into(),
        );
    }

    if let Some(creds) = crate::r2_s3::load_creds(app) {
        emit_progress(app, "deleting", 0, 1, "Removing objects from R2…");
        deleted_objects = crate::r2_s3::delete_prefix(&creds, slug).await?;
        log.push_str(&format!("Deleted {deleted_objects} R2 object(s) under {slug}/\n"));
    }

    if remote_required || store.kv_namespace_id.as_ref().is_some_and(|s| !s.is_empty()) {
        if let Ok((token, account_id, kv_id, _)) = load_cf_config(app) {
            emit_progress(app, "kv", 0, 1, "Removing KV event record…");
            delete_kv_value(&token, &account_id, &kv_id, slug).await?;
            log.push_str(&format!("Deleted KV record for {slug}\n"));
        } else if remote_required {
            return Err(
                "Cloudflare API token or KV namespace missing. Save keys, then delete again.".into(),
            );
        }
    }

    let mut store = AppStore::load(app);
    if keep_local {
        if let Some(ch) = store.channel_mut(slug) {
            ch.deployed = false;
            ch.master_url = None;
        }
        if store.last_slug.as_deref() == Some(slug) {
            store.last_master_url = None;
        }
        log.push_str("Kept local segments. You can upload again later.\n");
    } else {
        let pack_dir = AppStore::pack_dir(slug);
        if pack_dir.exists() {
            fs::remove_dir_all(&pack_dir)
                .map_err(|e| format!("could not remove local pack folder: {e}"))?;
            log.push_str("Removed local pack folder.\n");
        }
        store.remove_channel(slug);
    }
    store.save(app)?;

    emit_progress(
        app,
        "done",
        1,
        1,
        if keep_local {
            "Removed from R2"
        } else {
            "Video deleted"
        },
    );
    Ok(json!({
        "slug": slug,
        "deletedObjects": deleted_objects,
        "keptLocal": keep_local,
        "log": log
    }))
}

pub async fn rename_channel(
    app: &AppHandle,
    slug: &str,
    title: &str,
    new_slug: &str,
) -> Result<Value, String> {
    require_license(app)?;
    if !is_valid_slug(slug) {
        return Err("slug must be lowercase alphanumeric with hyphens".into());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("Display name is required.".into());
    }
    if title.len() > 200 {
        return Err("Display name is too long.".into());
    }
    let mut new_slug = slugify(new_slug.trim());
    if new_slug.len() > 64 {
        new_slug.truncate(64);
        while new_slug.ends_with('-') {
            new_slug.pop();
        }
    }
    if !is_valid_slug(&new_slug) {
        return Err("R2 folder must be lowercase letters, numbers, and hyphens.".into());
    }

    let store = AppStore::load(app);
    let channel = store
        .channels
        .iter()
        .find(|c| c.slug == slug)
        .cloned()
        .ok_or_else(|| "channel not found".to_string())?;

    if new_slug == slug {
        let mut store = AppStore::load(app);
        if let Some(ch) = store.channel_mut(slug) {
            ch.title = Some(title.to_string());
        }
        store.save(app)?;
        return Ok(json!({
            "slug": slug,
            "title": title,
            "log": "Updated display name.\n"
        }));
    }

    if store.channels.iter().any(|c| c.slug == new_slug) {
        return Err(format!("Another video already uses the folder name '{new_slug}'."));
    }
    if AppStore::pack_dir(&new_slug).exists() {
        return Err(format!("A local pack folder named '{new_slug}' already exists."));
    }

    let remote_required = channel.deployed || channel.master_url.as_ref().is_some_and(|u| !u.is_empty());
    if remote_required && crate::r2_s3::load_creds(app).is_none() {
        return Err(
            "Save Cloudflare keys on API keys & uploads so this video can be renamed on R2 and KV."
                .into(),
        );
    }

    set_active_slug(slug);
    emit_progress(app, "starting", 0, 0, "Renaming…");
    let mut log = String::new();
    let worker_origin = store.worker_origin.clone();
    let origin = worker_origin.as_deref();

    let creds = crate::r2_s3::load_creds(app);
    if let Some(creds) = &creds {
        let dest = crate::r2_s3::list_prefix(creds, &new_slug).await?;
        if !dest.is_empty() {
            return Err(format!("R2 already has objects under {new_slug}/"));
        }
    }

    let old_dir = AppStore::pack_dir(slug);
    let new_dir = AppStore::pack_dir(&new_slug);
    let kv_backup = fs::read(old_dir.join("kv-record.json")).ok();
    let mut renamed_local = false;
    if old_dir.exists() {
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("could not rename local pack folder: {e}"))?;
        renamed_local = true;
        rewrite_kv_record_slug(&new_dir, &new_slug, origin).map_err(|e| {
            rollback_pack_rename(slug, &new_slug, kv_backup.as_deref());
            e
        })?;
        log.push_str(&format!("Renamed local folder {slug} → {new_slug}\n"));
    }

    let mut copied_objects = 0u32;
    if let Some(creds) = &creds {
        emit_progress(app, "copying", 0, 1, "Copying R2 objects to the new folder…");
        match crate::r2_s3::copy_prefix(creds, slug, &new_slug).await {
            Ok(n) => {
                copied_objects = n;
                if n > 0 {
                    log.push_str(&format!("Copied {n} R2 object(s) to {new_slug}/\n"));
                }
            }
            Err(e) => {
                if renamed_local {
                    rollback_pack_rename(slug, &new_slug, kv_backup.as_deref());
                }
                let _ = crate::r2_s3::delete_prefix(creds, &new_slug).await;
                return Err(e);
            }
        }
    }

    let kv_body = fs::read_to_string(new_dir.join("kv-record.json")).ok();
    let should_write_kv = remote_required
        || (kv_body.is_some() && store.kv_namespace_id.as_ref().is_some_and(|s| !s.is_empty()));
    if should_write_kv {
        match load_cf_config(app) {
            Ok((token, account_id, kv_id, _)) => {
                if let Some(body) = &kv_body {
                    emit_progress(app, "kv", 0, 1, "Writing KV event record…");
                    let compact = serde_json::from_str::<Value>(body)
                        .and_then(|v| serde_json::to_string(&v))
                        .unwrap_or_else(|_| body.clone());
                    if let Err(e) = put_kv_value(&token, &account_id, &kv_id, &new_slug, &compact).await {
                        if renamed_local {
                            rollback_pack_rename(slug, &new_slug, kv_backup.as_deref());
                        }
                        if let Some(creds) = &creds {
                            let _ = crate::r2_s3::delete_prefix(creds, &new_slug).await;
                        }
                        return Err(e);
                    }
                    log.push_str(&format!("Wrote KV record for {new_slug}\n"));
                }
                if let Err(e) = delete_kv_value(&token, &account_id, &kv_id, slug).await {
                    log.push_str(&format!("Could not delete old KV record {slug}: {e}\n"));
                } else {
                    log.push_str(&format!("Deleted KV record for {slug}\n"));
                }
            }
            Err(e) if remote_required => {
                if renamed_local {
                    rollback_pack_rename(slug, &new_slug, kv_backup.as_deref());
                }
                if let Some(creds) = &creds {
                    let _ = crate::r2_s3::delete_prefix(creds, &new_slug).await;
                }
                return Err(e);
            }
            Err(_) => {}
        }
    }

    let master_url = if channel.deployed {
        worker_origin.as_ref().map(|origin| {
            format!(
                "{}/v1/events/{}/master.m3u8",
                origin.trim_end_matches('/'),
                new_slug
            )
        })
    } else {
        None
    };

    let mut ch = channel;
    ch.slug = new_slug.clone();
    ch.title = Some(title.to_string());
    ch.master_url = master_url.clone();

    let mut store = AppStore::load_from_disk(app);
    store.channels.retain(|c| c.slug != slug && c.slug != new_slug);
    store.upsert_channel(ch);
    if store.last_slug.as_deref() == Some(slug) || store.last_slug.as_deref() == Some(new_slug.as_str()) {
        store.last_slug = Some(new_slug.clone());
        store.last_master_url = master_url.clone();
    }
    store.save(app)?;

    if copied_objects > 0 {
        if let Some(creds) = &creds {
            emit_progress(app, "deleting", 0, 1, "Removing the old R2 folder…");
            match crate::r2_s3::delete_prefix(creds, slug).await {
                Ok(n) => log.push_str(&format!("Deleted {n} R2 object(s) under {slug}/\n")),
                Err(e) => log.push_str(&format!("Copied to {new_slug}/ but could not delete {slug}/: {e}\n")),
            }
        }
    }

    emit_progress(app, "done", 1, 1, "Renamed");
    log.push_str(&format!("Renamed {slug} → {new_slug}\n"));
    Ok(json!({
        "slug": new_slug,
        "title": title,
        "masterUrl": master_url,
        "copiedObjects": copied_objects,
        "log": log
    }))
}
