import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import BrandMark from "./components/BrandMark";
import CloudflareConnect from "./components/CloudflareConnect";
import ConsoleFooter, { type PackProgress } from "./components/ConsoleFooter";
import VideoWorkspace from "./components/VideoWorkspace";
import WorkerBindings, { type WorkerBindingStatus } from "./components/WorkerBindings";
import CloudflareKeysPage from "./pages/CloudflareKeys";
import LoginPage from "./pages/Login";

export type Channel = {
  slug: string;
  title: string | null;
  inputPath: string | null;
  packed: boolean;
  deployed: boolean;
  loop247: boolean;
  segmentDuration: number;
  totalSegments: number | null;
  durationSeconds: number | null;
  scheduledStart: number | null;
  masterUrl: string | null;
};

export type AppState = {
  licenseEmail: string | null;
  workerOrigin: string | null;
  accountId: string | null;
  lastSlug: string | null;
  lastMasterUrl: string | null;
  previewBaseUrl: string;
  cfAuthMode?: string | null;
  hasR2S3Keys?: boolean;
  channels: Channel[];
};

export const SCHEDULE_BUFFER_SECONDS = 60;

export function scheduleLocked(ch: Channel, now: number): boolean {
  if (!ch.deployed) return false;
  const start = ch.scheduledStart ?? 0;
  if (start <= 0) return false;
  const duration = Math.ceil(ch.durationSeconds ?? 0);
  if (duration <= 0) return now >= start;
  return now >= start && now < start + duration + SCHEDULE_BUFFER_SECONDS;
}

function channelStatus(ch: Channel, now: number) {
  if (!ch.packed) return "draft";
  if (!ch.deployed) return "packed";
  const start = ch.scheduledStart ?? 0;
  if (start <= 0 || now < start) return "offline";
  const duration = ch.durationSeconds ?? 0;
  if (!ch.loop247 && duration > 0 && now >= start + duration) return "ended";
  return "live";
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [cfBusy, setCfBusy] = useState(false);
  const [cfError, setCfError] = useState<string | null>(null);
  const [page, setPage] = useState<"videos" | "keys">("videos");
  const [consoleLog, setConsoleLog] = useState("Ready.\n");
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerBindingStatus | null>(null);

  const appendLog = useCallback((chunk: string) => {
    setConsoleLog((prev) => {
      const next = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
      if (prev.endsWith(next)) return prev;
      return `${prev}${next}`;
    });
  }, []);

  const refreshState = useCallback(async () => {
    const s = await invoke<AppState>("get_app_state");
    setState(s);
    setLoading(false);
    setSelected((prev) => {
      if (prev && s.channels.some((c) => c.slug === prev)) return prev;
      return s.channels[0]?.slug ?? null;
    });
    return s;
  }, []);

  const refresh = useCallback(async () => {
    return refreshState();
  }, [refreshState]);

  useEffect(() => {
    void refresh();
    const hb = window.setInterval(() => {
      void invoke("license_heartbeat").catch(() => {});
    }, 6 * 60 * 60 * 1000);
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      window.clearInterval(hb);
      window.clearInterval(tick);
    };
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<PackProgress>("pack-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.message) appendLog(event.payload.message);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [appendLog]);

  async function newVideo() {
    const ch = await invoke<Channel>("create_draft", { preferred: null });
    await refreshState();
    setSelected(ch.slug);
    setPage("videos");
  }

  async function logout() {
    setCfBusy(true);
    setCfError(null);
    try {
      await invoke("license_logout");
      await refreshState();
    } catch (e) {
      setCfError(String(e));
    } finally {
      setCfBusy(false);
    }
  }

  if (loading || !state) {
    return <div className="shell loading">Loading…</div>;
  }

  if (!state.licenseEmail) {
    return (
      <div className="shell">
        <header className="topbar">
          <BrandMark />
        </header>
        <main className="login-main">
          <LoginPage onDone={refresh} />
        </main>
      </div>
    );
  }

  const current = state.channels.find((c) => c.slug === selected) ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-actions">
          <CloudflareConnect accountId={state.accountId} hasR2S3Keys={state.hasR2S3Keys} />
          <span className="email">{state.licenseEmail}</span>
          <button type="button" className="secondary" disabled={cfBusy} onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      {cfError && <p className="banner-error">{cfError}</p>}
      {!state.hasR2S3Keys && (
        <div className="worker-banner warn">
          <p>
            Cloudflare keys are not set. Open <strong>API keys &amp; uploads</strong> and paste the
            token values. Uploads are disabled until then.
          </p>
        </div>
      )}
      {state.hasR2S3Keys && (
        <WorkerBindings
          signedIn
          busy={cfBusy}
          onBusy={setCfBusy}
          onLog={appendLog}
          onError={setCfError}
          onStatus={setWorkerStatus}
        />
      )}
      <div className="workspace">
        <aside className="sidebar">
          <button type="button" className="primary new-video" onClick={() => void newVideo()}>
            New video
          </button>
          <nav className="video-tabs">
            {state.channels.map((ch) => {
              const st = channelStatus(ch, now);
              return (
                <button
                  key={ch.slug}
                  type="button"
                  className={page === "videos" && ch.slug === selected ? "video-tab active" : "video-tab"}
                  onClick={() => {
                    setPage("videos");
                    setSelected(ch.slug);
                  }}
                >
                  <span className="video-tab-title">{ch.title || ch.slug}</span>
                  <span className={`badge badge-${st}`}>{st}</span>
                </button>
              );
            })}
          </nav>
          <button
            type="button"
            className={page === "keys" ? "video-tab active sidebar-docs" : "video-tab sidebar-docs"}
            onClick={() => setPage("keys")}
          >
            <span className="video-tab-title">API keys &amp; uploads</span>
            <span className={`badge ${state.hasR2S3Keys ? "badge-live" : "badge-offline"}`}>
              {state.hasR2S3Keys ? "ready" : "missing"}
            </span>
          </button>
        </aside>
        <div className="workspace-main">
          {page === "keys" ? (
            <CloudflareKeysPage
              state={state}
              busy={cfBusy}
              onBusy={setCfBusy}
              onDone={refreshState}
              onError={setCfError}
            />
          ) : current ? (
            state.channels.map((ch) => (
              <div key={ch.slug} hidden={ch.slug !== selected}>
                <VideoWorkspace
                  channel={ch}
                  state={state}
                  active={ch.slug === selected}
                  workerBindingsOk={workerStatus?.ok === true}
                  onDone={refreshState}
                  onSelectSlug={setSelected}
                  onConsoleLog={appendLog}
                  onJobBusy={setJobBusy}
                />
              </div>
            ))
          ) : (
            <div className="panel">
              <h1>No videos yet</h1>
              <p>Click New video to pick a file. Each video gets its own folder and R2 prefix.</p>
              <button type="button" className="primary" onClick={() => void newVideo()}>
                New video
              </button>
            </div>
          )}
        </div>
      </div>
      <ConsoleFooter log={consoleLog} progress={progress} busy={cfBusy || jobBusy} />
    </div>
  );
}
