use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub slug: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub input_path: Option<String>,
    #[serde(default)]
    pub packed: bool,
    #[serde(default)]
    pub deployed: bool,
    #[serde(default = "default_true")]
    pub loop247: bool,
    #[serde(default = "default_seg")]
    pub segment_duration: u32,
    #[serde(default)]
    pub total_segments: Option<u64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub scheduled_start: Option<i64>,
    #[serde(default)]
    pub master_url: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_seg() -> u32 {
    4
}

fn channel_richness(ch: &Channel) -> (u8, u8, u8, u8) {
    (
        ch.deployed as u8,
        ch.master_url.as_ref().is_some_and(|u| !u.is_empty()) as u8,
        ch.title
            .as_ref()
            .is_some_and(|t| !t.is_empty() && t != &ch.slug) as u8,
        ch.input_path.is_some() as u8,
    )
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStore {
    pub license_email: Option<String>,
    pub license_token: Option<String>,
    pub cf_api_token: Option<String>,
    #[serde(default)]
    pub cf_refresh_token: Option<String>,
    #[serde(default)]
    pub cf_auth_mode: Option<String>,
    pub worker_origin: Option<String>,
    pub account_id: Option<String>,
    pub bucket_name: Option<String>,
    pub kv_namespace_id: Option<String>,
    pub last_slug: Option<String>,
    pub last_master_url: Option<String>,
    #[serde(default)]
    pub r2_access_key_id: Option<String>,
    #[serde(default)]
    pub r2_secret_access_key: Option<String>,
    #[serde(default)]
    pub channels: Vec<Channel>,
}

impl AppStore {
    pub fn path(_app: &AppHandle) -> PathBuf {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("CalculatedLive").join("state.json")
    }

    pub fn pack_root() -> PathBuf {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("CalculatedLive").join("pack")
    }

    pub fn pack_dir(slug: &str) -> PathBuf {
        Self::pack_root().join(slug)
    }

    pub fn load(app: &AppHandle) -> Self {
        let mut store = Self::load_from_disk(app);
        store.discover_packs();
        store.drop_stale_packs();
        store.dedupe_channels();
        store
    }

    pub(crate) fn load_from_disk(app: &AppHandle) -> Self {
        let path = Self::path(app);
        if let Ok(raw) = fs::read_to_string(&path) {
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::path(app);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, raw).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_channel(&mut self, slug: &str) {
        self.channels.retain(|c| c.slug != slug);
        if self.last_slug.as_deref() == Some(slug) {
            self.last_slug = None;
            self.last_master_url = None;
        }
    }

    pub fn upsert_channel(&mut self, ch: Channel) {
        if let Some(existing) = self.channels.iter_mut().find(|c| c.slug == ch.slug) {
            *existing = ch;
        } else {
            self.channels.push(ch);
        }
    }

    pub fn channel_mut(&mut self, slug: &str) -> Option<&mut Channel> {
        self.channels.iter_mut().find(|c| c.slug == slug)
    }

    /// Packed channels whose folder is gone (e.g. leftover after a rename).
    fn drop_stale_packs(&mut self) {
        self.channels
            .retain(|c| !c.packed || Self::pack_dir(&c.slug).exists());
    }

    fn dedupe_channels(&mut self) {
        let mut best: HashMap<String, Channel> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        for ch in self.channels.drain(..) {
            let slug = ch.slug.clone();
            match best.get(&slug) {
                None => {
                    order.push(slug.clone());
                    best.insert(slug, ch);
                }
                Some(existing) => {
                    if channel_richness(&ch) > channel_richness(existing) {
                        best.insert(slug, ch);
                    }
                }
            }
        }
        self.channels = order.into_iter().filter_map(|s| best.remove(&s)).collect();
    }

    fn discover_packs(&mut self) {
        let root = Self::pack_root();
        let Ok(entries) = fs::read_dir(&root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if slug.is_empty() {
                continue;
            }
            let packed = path.join("hls.m3u8").is_file() || path.join("cdn").is_dir();
            if !packed {
                continue;
            }
            if self.channels.iter().any(|c| c.slug == slug) {
                continue;
            }
            let mut ch = Channel {
                slug: slug.to_string(),
                title: Some(slug.to_string()),
                input_path: None,
                packed: true,
                deployed: self.last_slug.as_deref() == Some(slug) && self.last_master_url.is_some(),
                loop247: true,
                segment_duration: 4,
                total_segments: None,
                duration_seconds: None,
                scheduled_start: None,
                master_url: if self.last_slug.as_deref() == Some(slug) {
                    self.last_master_url.clone()
                } else {
                    None
                },
            };
            if let Ok(raw) = fs::read_to_string(path.join("kv-record.json")) {
                if let Ok(rec) = serde_json::from_str::<serde_json::Value>(&raw) {
                    ch.total_segments = rec["totalSegments"].as_u64();
                    ch.duration_seconds = rec["durationSeconds"].as_f64();
                    ch.scheduled_start = rec["scheduledStart"].as_i64();
                    ch.loop247 = rec["replayMode"].as_str() == Some("loop");
                    ch.segment_duration = rec["segmentDuration"].as_u64().unwrap_or(4) as u32;
                    if rec["storageBaseUrl"].as_str().is_some_and(|u| u.contains("workers.dev")) {
                        ch.deployed = true;
                    }
                }
            }
            self.channels.push(ch);
        }
    }
    pub fn allocate_slug(&self, preferred: &str) -> String {
        let base = slugify(preferred);
        let mut candidate = base.clone();
        let mut n = 2;
        loop {
            let taken = self.channels.iter().any(|c| c.slug == candidate)
                || Self::pack_dir(&candidate).join("hls.m3u8").is_file();
            if !taken {
                return candidate;
            }
            candidate = format!("{base}-{n}");
            n += 1;
        }
    }
}

pub fn is_valid_slug(slug: &str) -> bool {
    let n = slug.len();
    n >= 1
        && n <= 64
        && slug
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn slugify(raw: &str) -> String {
    let lowered: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let mut out = String::new();
    for c in lowered.trim_matches('-').chars() {
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    if out.is_empty() {
        "video".into()
    } else {
        out
    }
}

pub fn device_id() -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into());
    let input = format!("{}:{}", host, std::env::consts::OS);
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(input.as_bytes());
    format!("{:x}", hash)[..32].to_string()
}
