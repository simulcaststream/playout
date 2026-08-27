import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppState, Channel } from "../App";
import { scheduleLocked } from "../App";
import CloudflareConnect from "./CloudflareConnect";
import PreviewPlayer from "./PreviewPlayer";

type Props = {
  channel: Channel;
  state: AppState;
  active: boolean;
  workerBindingsOk: boolean;
  onDone: () => Promise<unknown> | void;
  onSelectSlug: (slug: string) => void;
  onConsoleLog: (log: string) => void;
  onJobBusy: (busy: boolean) => void;
};

function localDateTimeValue(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromEpoch(epoch: number) {
  return localDateTimeValue(new Date(epoch * 1000));
}

function formatWhen(epoch: number | null) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString();
}

function toSlug(raw: string) {
  const lowered = [...raw.toLowerCase()].map((c) => (/[a-z0-9]/.test(c) ? c : "-")).join("");
  const slug = lowered.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || "video";
}

function invokeError(e: unknown): string {
  const raw =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
          ? (e as { message: string }).message
          : String(e);
  if (/authentication|unauthorized|invalid api token|invalid access token/i.test(raw)) {
    return "Cloudflare API token was rejected. Paste a new token.";
  }
  return raw;
}

function statusOf(ch: Channel, now: number): "draft" | "packed" | "offline" | "live" | "ended" {
  if (!ch.packed) return "draft";
  if (!ch.deployed) return "packed";
  const start = ch.scheduledStart ?? 0;
  if (start <= 0 || now < start) return "offline";
  const duration = ch.durationSeconds ?? 0;
  if (!ch.loop247 && duration > 0 && now >= start + duration) return "ended";
  return "live";
}

export default function VideoWorkspace({
  channel,
  state,
  active,
  workerBindingsOk,
  onDone,
  onSelectSlug,
  onConsoleLog,
  onJobBusy,
}: Props) {
  const [inputPath, setInputPath] = useState(channel.inputPath ?? "");
  const [segmentDuration, setSegmentDuration] = useState(channel.segmentDuration || 4);
  const [loop247, setLoop247] = useState(channel.loop247);
  const [startLocal, setStartLocal] = useState(
    channel.scheduledStart ? fromEpoch(channel.scheduledStart) : localDateTimeValue(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keepLocal, setKeepLocal] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [title, setTitle] = useState(channel.title || channel.slug);
  const [folder, setFolder] = useState(channel.slug);
  const [confirmRename, setConfirmRename] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    setInputPath(channel.inputPath ?? "");
    setSegmentDuration(channel.segmentDuration || 4);
    setLoop247(channel.loop247);
    setStartLocal(channel.scheduledStart ? fromEpoch(channel.scheduledStart) : localDateTimeValue());
    setConfirmRemove(false);
    setConfirmRename(false);
    setTitle(channel.title || channel.slug);
    setFolder(channel.slug);
  }, [channel.slug, channel.inputPath, channel.segmentDuration, channel.loop247, channel.scheduledStart, channel.title]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const status = statusOf(channel, now);
  const locked = scheduleLocked(channel, now);
  const previewSrc =
    active && channel.packed ? `${state.previewBaseUrl}/${channel.slug}/hls.m3u8` : "";
  const keysReady = Boolean(state.hasR2S3Keys);

  function setBusyAll(next: boolean) {
    setBusy(next);
    onJobBusy(next);
  }

  async function pickFile() {
    const selected = await invoke<string | null>("pick_video_file");
    if (!selected) return;
    setError(null);
    try {
      const next = await invoke<Channel>("attach_source", { slug: channel.slug, inputPath: selected });
      setInputPath(selected);
      await onDone();
      onSelectSlug(next.slug);
    } catch (e) {
      setError(invokeError(e));
    }
  }

  async function packLocal() {
    if (!inputPath) {
      setError("Select a video first.");
      return;
    }
    setBusyAll(true);
    setError(null);
    onConsoleLog("Building segments into a dedicated folder…\n");
    try {
      const res = await invoke<{ log: string }>("pack_local", {
        inputPath,
        slug: channel.slug,
        segmentDuration,
        loop247,
      });
      onConsoleLog(res.log);
      await onDone();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusyAll(false);
    }
  }

  async function deploy() {
    if (!keysReady) {
      setError("Save Cloudflare keys on API keys & uploads. Uploads are disabled until then.");
      return;
    }
    const scheduledStart = Math.floor(new Date(startLocal).getTime() / 1000);
    if (!Number.isFinite(scheduledStart) || scheduledStart <= 0) {
      setError("Set a valid go-live date and time.");
      return;
    }
    setBusyAll(true);
    setError(null);
    onConsoleLog("Uploading segments and writing the live KV record…\n");
    try {
      const res = await invoke<{ log: string }>("deploy_channel", {
        slug: channel.slug,
        scheduledStart,
        loop247,
      });
      onConsoleLog(res.log);
      await onDone();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusyAll(false);
    }
  }

  async function saveStart() {
    const scheduledStart = Math.floor(new Date(startLocal).getTime() / 1000);
    setBusyAll(true);
    setError(null);
    try {
      await invoke("update_schedule", { slug: channel.slug, scheduledStart });
      onConsoleLog("Start time saved.\n");
      await onDone();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusyAll(false);
    }
  }

  async function copyUrl() {
    if (!channel.masterUrl) return;
    await navigator.clipboard.writeText(channel.masterUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const nextSlug = toSlug(folder);
  const nameDirty = title.trim() !== (channel.title || channel.slug) || nextSlug !== channel.slug;

  async function saveName() {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("Display name is required.");
      return;
    }
    if (nextSlug !== channel.slug && !confirmRename) {
      setConfirmRename(true);
      return;
    }
    setBusyAll(true);
    setError(null);
    onConsoleLog(
      nextSlug !== channel.slug
        ? `Renaming ${channel.slug} → ${nextSlug}…\n`
        : `Updating display name…\n`,
    );
    try {
      const res = await invoke<{ slug: string; log?: string }>("rename_channel", {
        slug: channel.slug,
        title: nextTitle,
        newSlug: nextSlug,
      });
      if (res.log) onConsoleLog(res.log);
      setConfirmRename(false);
      onSelectSlug(res.slug);
      await onDone();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusyAll(false);
    }
  }

  async function removeVideo() {
    const name = channel.title || channel.slug;
    setBusyAll(true);
    setError(null);
    setConfirmRemove(false);
    onConsoleLog(keepLocal ? `Removing ${name} from R2…\n` : `Deleting ${name}…\n`);
    try {
      const res = await invoke<{ log?: string }>("delete_channel", {
        slug: channel.slug,
        keepLocal,
      });
      if (res.log) onConsoleLog(res.log);
      await onDone();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div className="panel workspace-panel">
      <div className="deploy-head">
        <h1>{channel.title || channel.slug}</h1>
        <span className={`badge badge-${status}`}>{status}</span>
      </div>
      <p className="mono-inline">R2 prefix / URL key: {channel.slug}</p>

      <h2>Name</h2>
      <p className="muted">
        Display name is what you see in the sidebar. R2 folder is the object prefix and live URL
        path. Changing the folder copies objects to the new prefix, then deletes the old one.
      </p>
      <label>
        Display name
        <input
          value={title}
          disabled={busy}
          onChange={(e) => {
            setTitle(e.target.value);
            setConfirmRename(false);
          }}
        />
      </label>
      <label>
        R2 folder
        <input
          value={folder}
          disabled={busy}
          onChange={(e) => {
            setFolder(e.target.value);
            setConfirmRename(false);
          }}
        />
      </label>
      {nextSlug !== folder.trim().toLowerCase() && (
        <p className="muted">Saved as: {nextSlug}</p>
      )}
      {confirmRename ? (
        <div className="confirm-remove">
          <p>
            This moves R2 objects from {channel.slug}/ to {nextSlug}/ and updates the live URL.
            Existing player links that use the old path will stop working.
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void saveName()}>
              {busy ? "Renaming…" : "Confirm rename"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmRename(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="primary" disabled={busy || !nameDirty} onClick={() => void saveName()}>
          Save name
        </button>
      )}

      <h2>1. Source &amp; pack</h2>
      <label>
        Source video
        <div className="row">
          <input
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder="/path/to/video.mp4"
            disabled={channel.packed}
          />
          <button type="button" className="secondary" disabled={busy || channel.packed} onClick={() => void pickFile()}>
            Browse
          </button>
        </div>
      </label>
      <label>
        Segment duration (seconds)
        <input
          type="number"
          min={2}
          max={10}
          value={segmentDuration}
          disabled={channel.packed}
          onChange={(e) => setSegmentDuration(Number(e.target.value))}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={loop247}
          disabled={channel.deployed}
          onChange={(e) => setLoop247(e.target.checked)}
        />{" "}
        Loop 24/7 after go-live
      </label>
      {!channel.packed && (
        <>
          <button type="button" className="primary" disabled={busy || !inputPath} onClick={() => void packLocal()}>
            {busy ? "Packing…" : "Build segments"}
          </button>
          <p className="muted">
            Ladder uses the source codec and resolutions at or below the source height. H.264 is never
            transcoded to HEVC. 4K HEVC only if the file already is.
          </p>
        </>
      )}
      {channel.packed && <p className="success">Segments ready in a dedicated folder for {channel.slug}.</p>}

      {channel.packed && (
        <>
          <h2>2. Local preview</h2>
          <p>Plays the packed HLS locally (full VOD) so you can check picture and audio before upload.</p>
          <p className="mono-inline">{state.previewBaseUrl}/{channel.slug}/hls.m3u8</p>
          <PreviewPlayer src={previewSrc} />
        </>
      )}

      {channel.packed && (
        <>
          <h2>3. Upload to Cloudflare</h2>
          <CloudflareConnect accountId={state.accountId} hasR2S3Keys={state.hasR2S3Keys} />
          <label>
            Go live (local time)
            <div className="row">
              <input
                type="datetime-local"
                value={startLocal}
                disabled={locked}
                onChange={(e) => setStartLocal(e.target.value)}
              />
              {!locked && (
                <button type="button" className="secondary" onClick={() => setStartLocal(localDateTimeValue())}>
                  Now
                </button>
              )}
            </div>
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !keysReady || !workerBindingsOk}
            onClick={() => void deploy()}
          >
            {busy
              ? channel.deployed
                ? "Updating…"
                : "Uploading…"
              : channel.deployed
                ? "Upload / update live record"
                : "Upload / resume to R2"}
          </button>
          {!keysReady && (
            <p className="error">
              Cloudflare keys are not set. Open <strong>API keys &amp; uploads</strong> and paste
              the token values.
            </p>
          )}
          {!workerBindingsOk && keysReady && (
            <p className="error">Worker bindings are missing. Redeploy the Worker, then Recheck.</p>
          )}
          <div className="callout">
            <p>
              <strong>Uploads go to R2 over S3.</strong> Segment files are PUT to{" "}
              <code>{"<account>.r2.cloudflarestorage.com"}</code>. That does not create a Worker
              request per file — only R2 Class A writes.
            </p>
            <p>
              Then one KV record is written for this video so viewers can load live playlists.
              Redeploy the Worker only if bindings are missing. Workers Paid and R2 do not charge
              egress.
            </p>
          </div>
          <p className="muted">
            {channel.deployed
              ? "Checks R2 for anything missing and rewrites the live KV record. Already-uploaded segments are skipped. The Worker is not redeployed."
              : "Checks R2 first and skips segments that are already there, then writes the live KV record."}
          </p>
          {channel.deployed && !locked && (
            <button type="button" className="primary" disabled={busy} onClick={() => void saveStart()}>
              Save start time
            </button>
          )}
          {locked && (
            <p className="muted">
              Start time is locked until this playthrough ends (go-live + video length + 1 minute).
            </p>
          )}
          {channel.deployed && !locked && (
            <p className="muted">Set a new go-live time to run this video again. Segments stay on R2.</p>
          )}
          {channel.masterUrl && (
            <>
              <div className="mono">{channel.masterUrl}</div>
              <div className="row">
                <button type="button" className="secondary" onClick={() => void copyUrl()}>
                  {copied ? "Copied!" : "Copy live URL"}
                </button>
              </div>
              <p className="muted">Go live: {formatWhen(channel.scheduledStart)}</p>
            </>
          )}
        </>
      )}

      <h2>Delete</h2>
      <p className="muted">
        Removes this video from R2 and the live KV record. Uncheck below if you also want to wipe
        local segments and remove it from the sidebar.
      </p>
      <label>
        <input
          type="checkbox"
          checked={keepLocal}
          disabled={busy}
          onChange={(e) => {
            setKeepLocal(e.target.checked);
            setConfirmRemove(false);
          }}
        />{" "}
        Keep local segments (upload again later)
      </label>
      {confirmRemove ? (
        <div className="confirm-remove">
          <p>
            {keepLocal
              ? "This deletes R2 objects and the live KV record. Local segments stay so you can upload again. Playback stops."
              : channel.deployed || channel.masterUrl
                ? "This removes local segments, R2 objects, and the live KV record. Playback will stop."
                : "This removes it from this app and the local pack folder."}
          </p>
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => void removeVideo()}>
              {busy ? "Removing…" : keepLocal ? "Confirm remove from R2" : "Confirm delete"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
          {keepLocal ? "Remove from R2" : "Delete video"}
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
