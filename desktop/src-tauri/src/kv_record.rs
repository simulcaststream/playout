//! Normalize Shaka HLS output into cdn/ layout and kv-record.json (desktop app).
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Clone)]
struct VideoTrack {
    bandwidth: u64,
    avg_bandwidth: u64,
    codecs: String,
    resolution: String,
    frame_rate: f64,
    playlist: String,
}

#[derive(Clone)]
struct AudioTrack {
    playlist: String,
    group: String,
    name: String,
    channels: u32,
    default: bool,
}

struct NormalizedTrack {
    init_path: String,
    segment_pattern: String,
    segment_count: usize,
}

fn xml_attr(line: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_master(path: &Path) -> Result<(Vec<AudioTrack>, Vec<VideoTrack>), String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut audio = Vec::new();
    let mut video = Vec::new();
    let mut pending: Option<VideoTrack> = None;

    for line in text.lines().map(str::trim) {
        if line.starts_with("#EXT-X-MEDIA:TYPE=AUDIO") {
            let uri = xml_attr(line, "URI").ok_or("audio track missing URI")?;
            let group = xml_attr(line, "GROUP-ID").unwrap_or_else(|| "aud".into());
            let name = xml_attr(line, "NAME").unwrap_or_else(|| "Audio".into());
            let channels = xml_attr(line, "CHANNELS")
                .and_then(|s| s.parse().ok())
                .unwrap_or(2);
            let default = line.contains("DEFAULT=YES");
            audio.push(AudioTrack {
                playlist: uri,
                group,
                name,
                channels,
                default,
            });
        } else if line.starts_with("#EXT-X-STREAM-INF:") {
            pending = Some(VideoTrack {
                bandwidth: xml_attr(line, "BANDWIDTH")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                avg_bandwidth: xml_attr(line, "AVERAGE-BANDWIDTH")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                codecs: xml_attr(line, "CODECS")
                    .map(|c| c.split(',').next().unwrap_or(&c).to_string())
                    .unwrap_or_else(|| "avc1.64001f".into()),
                resolution: xml_attr(line, "RESOLUTION").unwrap_or_else(|| "1280x720".into()),
                frame_rate: xml_attr(line, "FRAME-RATE")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(24.0),
                playlist: String::new(),
            });
        } else if let Some(mut track) = pending.take() {
            if !line.is_empty() && !line.starts_with('#') {
                track.playlist = line.to_string();
                video.push(track);
            }
        }
    }
    Ok((audio, video))
}

fn parse_media_playlist(path: &Path) -> Result<(String, Vec<String>), String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut init_path = String::new();
    let mut segments = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("#EXT-X-MAP:") {
            init_path = xml_attr(line, "URI").unwrap_or_default();
        } else if line.starts_with("#EXTINF:") && i + 1 < lines.len() {
            let uri = lines[i + 1];
            if !uri.is_empty() && !uri.starts_with('#') {
                segments.push(uri.to_string());
            }
        }
        i += 1;
    }
    Ok((init_path, segments))
}

fn rendition_height(resolution: &str) -> u32 {
    resolution
        .split('x')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn rendition_label(resolution: &str) -> String {
    let h = rendition_height(resolution);
    if h >= 2160 {
        "2160p".into()
    } else if h >= 1440 {
        "1440p".into()
    } else if h >= 1080 {
        "1080p".into()
    } else if h >= 720 {
        "720p".into()
    } else if h >= 480 {
        "480p".into()
    } else if h >= 360 {
        "360p".into()
    } else {
        "240p".into()
    }
}

fn audio_track_name(base_name: &str, channels: u32) -> String {
    if channels >= 6 {
        format!("{base_name} 5.1")
    } else if channels == 1 {
        format!("{base_name} Mono")
    } else {
        format!("{base_name} Stereo")
    }
}

fn audio_cdn_label(group: &str) -> &str {
    match group {
        "aac" | "stereo" | "mono" => "aac",
        "eac3" | "surround" => "eac3",
        other => other,
    }
}

fn unique_rendition_name(resolution: &str, used: &mut HashSet<String>) -> String {
    let base = rendition_label(resolution);
    if used.insert(base.clone()) {
        base
    } else {
        let fallback = format!("{}_{resolution}", rendition_label(resolution));
        used.insert(fallback.clone());
        fallback
    }
}

fn normalize_track(
    shaka_dir: &Path,
    cdn_dir: &Path,
    kind: &str,
    label: &str,
    init_src: &str,
    segment_srcs: &[String],
) -> Result<NormalizedTrack, String> {
    let base = if kind == "video" {
        format!("video/{label}")
    } else {
        format!("audio/{label}")
    };
    let out_base = cdn_dir.join(&base);
    fs::create_dir_all(&out_base).map_err(|e| e.to_string())?;
    fs::copy(shaka_dir.join(init_src), out_base.join("init.mp4")).map_err(|e| e.to_string())?;
    let segment_pattern = format!("{base}/seg_%05d.m4s");
    for (i, src) in segment_srcs.iter().enumerate() {
        let dest = out_base.join(format!("seg_{:05}.m4s", i));
        fs::copy(shaka_dir.join(src), dest).map_err(|e| e.to_string())?;
    }
    Ok(NormalizedTrack {
        init_path: format!("{base}/init.mp4"),
        segment_pattern,
        segment_count: segment_srcs.len(),
    })
}

pub fn build_kv_record(
    outdir: &Path,
    slug: &str,
    storage_base_url: &str,
    segment_duration: u32,
    loop247: bool,
    scheduled_start: i64,
    log: &mut String,
) -> Result<Value, String> {
    let master_path = outdir.join("hls.m3u8");
    let cdn_dir = outdir.join("cdn");
    fs::create_dir_all(&cdn_dir).map_err(|e| e.to_string())?;

    let (master_audio, mut master_video) = parse_master(&master_path)?;
    if master_video.is_empty() {
        return Err(format!("no video renditions found in {}", master_path.display()));
    }
    master_video.sort_by(|a, b| {
        rendition_height(&b.resolution).cmp(&rendition_height(&a.resolution))
    });

    let primary = &master_video[0];
    let (_primary_init, primary_segments) =
        parse_media_playlist(&outdir.join(&primary.playlist))?;
    let primary_label = rendition_label(&primary.resolution);
    let mut video_norm: HashMap<String, NormalizedTrack> = HashMap::new();

    for track in &master_video {
        let label = rendition_label(&track.resolution);
        if video_norm.contains_key(&label) {
            continue;
        }
        let (init, segments) = parse_media_playlist(&outdir.join(&track.playlist))?;
        let count = primary_segments.len().min(segments.len());
        let norm = normalize_track(
            outdir,
            &cdn_dir,
            "video",
            &label,
            &init,
            &segments[..count],
        )?;
        video_norm.insert(label, norm);
    }

    let total_segments = video_norm
        .get(&primary_label)
        .map(|n| n.segment_count)
        .ok_or_else(|| "primary video normalization failed".to_string())?;

    log.push_str(&format!(
        "video renditions: {}\n",
        master_video
            .iter()
            .map(|v| format!("{} ({})", rendition_label(&v.resolution), v.resolution))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    let scheduled = if scheduled_start > 0 {
        scheduled_start
    } else {
        unix_now()
    };

    let mut audio_out: Vec<Value> = Vec::new();
    let mut seen_playlists = HashSet::new();
    for track in &master_audio {
        if !seen_playlists.insert(track.playlist.clone()) {
            continue;
        }
        let (init, segments) = parse_media_playlist(&outdir.join(&track.playlist))?;
        let label = audio_cdn_label(&track.group);
        let count = total_segments.min(segments.len());
        let norm = normalize_track(
            outdir,
            &cdn_dir,
            "audio",
            label,
            &init,
            &segments[..count],
        )?;
        let audio_codec = if label == "aac" {
            "mp4a.40.2"
        } else {
            "ec-3"
        };
        let base_name = if track.name == "und" {
            "English"
        } else {
            track.name.as_str()
        };
        audio_out.push(json!({
            "group": "aud",
            "name": audio_track_name(base_name, track.channels),
            "language": "en",
            "codecs": audio_codec,
            "channels": track.channels,
            "default": track.default && track.channels <= 2,
            "bandwidth": if label == "aac" { 128_000 } else { 384_000 },
            "initPath": norm.init_path,
            "segmentPattern": norm.segment_pattern,
        }));
    }

    if audio_out.is_empty() {
        return Err("no audio tracks found — source must include an audio track".into());
    }
    if !audio_out.iter().any(|a| a["default"].as_bool() == Some(true)) {
        if let Some(stereo) = audio_out
            .iter()
            .position(|a| a["channels"].as_u64().unwrap_or(2) <= 2)
        {
            audio_out[stereo]["default"] = json!(true);
        } else if let Some(first) = audio_out.first_mut() {
            first["default"] = json!(true);
        }
    }

    let default_bw = audio_out
        .iter()
        .find(|a| a["default"].as_bool() == Some(true))
        .or_else(|| audio_out.first())
        .and_then(|a| a["bandwidth"].as_u64())
        .unwrap_or(128_000);

    let mut used_names = HashSet::new();
    let mut video_out = Vec::new();
    for track in &master_video {
        let name = unique_rendition_name(&track.resolution, &mut used_names);
        if !video_norm.contains_key(&name) {
            let (init, segments) = parse_media_playlist(&outdir.join(&track.playlist))?;
            let count = primary_segments.len().min(segments.len());
            let norm = normalize_track(
                outdir,
                &cdn_dir,
                "video",
                &name,
                &init,
                &segments[..count],
            )?;
            video_norm.insert(name.clone(), norm);
        }
        let norm = video_norm.get(&name).unwrap();
        video_out.push(json!({
            "name": name,
            "bandwidth": track.bandwidth + default_bw,
            "avgBandwidth": track.avg_bandwidth + default_bw,
            "codecs": track.codecs,
            "resolution": track.resolution,
            "frameRate": track.frame_rate,
            "initPath": norm.init_path,
            "segmentPattern": norm.segment_pattern,
            "audioGroup": "aud",
        }));
    }

    let replay_mode = if loop247 { "loop" } else { "none" };
    let record = json!({
        "eventId": format!("evt_{slug}"),
        "slug": slug,
        "scheduledStart": scheduled,
        "segmentDuration": segment_duration,
        "totalSegments": total_segments,
        "durationSeconds": total_segments as f64 * f64::from(segment_duration),
        "windowSize": 6,
        "joinFromStart": false,
        "replayMode": replay_mode,
        "gate": "open",
        "storageBaseUrl": storage_base_url,
        "video": video_out,
        "audio": audio_out,
    });

    let out_path = outdir.join("kv-record.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&record).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| e.to_string())?;

    log.push_str(&format!("wrote {}\n", out_path.display()));
    log.push_str(&format!("normalized CDN assets -> {}\n", cdn_dir.display()));
    log.push_str(&format!(
        "segments: {total_segments} x {segment_duration}s\n"
    ));

    Ok(record)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
