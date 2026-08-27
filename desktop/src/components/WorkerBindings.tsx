import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type WorkerBindingStatus = {
  ok: boolean;
  exists: boolean;
  missing: string[];
  present: string[];
  message: string;
};

type Props = {
  signedIn: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onLog: (log: string) => void;
  onError: (message: string | null) => void;
  onStatus: (status: WorkerBindingStatus | null) => void;
};

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

export default function WorkerBindings({ signedIn, busy, onBusy, onLog, onError, onStatus }: Props) {
  const [status, setStatus] = useState<WorkerBindingStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    if (!signedIn) {
      setStatus(null);
      onStatus(null);
      return;
    }
    setChecking(true);
    onError(null);
    try {
      const next = await invoke<WorkerBindingStatus>("check_worker_bindings");
      setStatus(next);
      onStatus(next);
      onLog(`${next.message}${next.missing.length ? ` Missing: ${next.missing.join(", ")}` : ""}\n`);
    } catch (e) {
      const msg = invokeError(e);
      onError(msg);
      onLog(`${msg}\n`);
    } finally {
      setChecking(false);
    }
  }, [signedIn, onError, onLog, onStatus]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  async function redeploy() {
    onBusy(true);
    onError(null);
    onLog("Redeploying playback Worker…\n");
    try {
      const res = await invoke<{ workerOrigin?: string }>("redeploy_worker");
      onLog(
        `Worker redeployed${res.workerOrigin ? ` · ${res.workerOrigin}` : ""}. Rechecking bindings…\n`,
      );
      await recheck();
    } catch (e) {
      const msg = invokeError(e);
      onError(msg);
      onLog(`${msg}\n`);
    } finally {
      onBusy(false);
    }
  }

  if (!signedIn) return null;

  const ok = status?.ok === true;
  const warn = status != null && !ok;

  return (
    <div className={`worker-banner ${ok ? "ok" : warn ? "warn" : ""}`}>
      <p>
        {checking && !status
          ? "Checking Worker bindings…"
          : warn
            ? status.message
            : ok
              ? "Worker bindings OK"
              : "Checking Worker bindings…"}
        {warn && status.missing.length > 0 ? ` (${status.missing.join(", ")})` : ""}
      </p>
      <div className="row">
        <button type="button" className="secondary" disabled={busy || checking} onClick={() => void recheck()}>
          {checking ? "Checking…" : "Recheck"}
        </button>
        <button type="button" className="secondary" disabled={busy || checking} onClick={() => void redeploy()}>
          {busy ? "Redeploying…" : "Redeploy Worker"}
        </button>
      </div>
    </div>
  );
}
