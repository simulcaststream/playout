import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppState } from "../App";

type Props = {
  state: AppState;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: () => Promise<unknown> | void;
  onError: (message: string | null) => void;
};

const ACCOUNT_TOKEN_URL =
  "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%5D&name=Playout";

const USER_TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Playout";

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

export default function CloudflareKeysPage({ state, busy, onBusy, onDone, onError }: Props) {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [s3Endpoint, setS3Endpoint] = useState("");

  const canSave = Boolean(
    apiToken.trim() && accessKeyId.trim() && secretAccessKey.trim() && (accountId.trim() || s3Endpoint.trim()),
  );

  async function saveKeys() {
    if (!canSave) {
      onError("Paste Account ID, API token, Access Key ID, and Secret Access Key from the token screen.");
      return;
    }
    onBusy(true);
    onError(null);
    try {
      await invoke("verify_cloudflare_token", {
        accountId: accountId.trim() || null,
        apiToken: apiToken.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        s3Endpoint: s3Endpoint.trim() || null,
      });
      setAccountId("");
      setApiToken("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setS3Endpoint("");
      await onDone();
    } catch (e) {
      onError(invokeError(e));
    } finally {
      onBusy(false);
    }
  }

  async function openUrl(url: string) {
    await invoke("open_external_url", { url });
  }

  const connected = Boolean(state.accountId);

  return (
    <div className="panel docs-page">
      <h1>API keys &amp; uploads</h1>
      <p>
        Create or roll <strong>one</strong> Cloudflare token. The confirmation screen lists every
        value this app needs — paste them below. Copy the API token and Secret now; Cloudflare will
        not show them again.
      </p>
      <p className="row">
        <button type="button" className="primary" onClick={() => void openUrl(ACCOUNT_TOKEN_URL)}>
          Create or roll token
        </button>
        <button type="button" className="secondary" onClick={() => void openUrl(USER_TOKEN_URL)}>
          User token instead
        </button>
      </p>
      <p className="muted">
        Opens Account API Tokens with Workers, KV, and R2 already selected. Use User token instead
        if you are not a Super Administrator.
      </p>

      {connected ? (
        <p className="success">
          Cloudflare connected{state.accountId ? ` · ${state.accountId}` : ""}
          {state.hasR2S3Keys ? " · R2 S3 keys" : ""}
        </p>
      ) : (
        <p className="muted">No keys saved yet. Uploads are disabled until you save them.</p>
      )}

      <form
        className="cf-token-form"
        onSubmit={(e) => {
          e.preventDefault();
          void saveKeys();
        }}
      >
        <label>
          Account ID
          <input
            type="text"
            autoComplete="off"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="32-character account id"
          />
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="off"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Starts with cfat_ or a user token"
          />
        </label>
        <label>
          Access Key ID
          <input
            type="text"
            autoComplete="off"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="S3-compatible Access Key ID"
          />
        </label>
        <label>
          Secret Access Key
          <input
            type="password"
            autoComplete="off"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="S3-compatible Secret Access Key"
          />
        </label>
        <label>
          S3 API endpoint
          <input
            type="text"
            autoComplete="off"
            value={s3Endpoint}
            onChange={(e) => setS3Endpoint(e.target.value)}
            placeholder="https://<account>.r2.cloudflarestorage.com"
          />
        </label>
        <button type="submit" className="primary" disabled={busy || !canSave}>
          {busy ? "Saving…" : connected ? "Replace keys" : "Save keys"}
        </button>
      </form>

      <p className="muted">
        Segment uploads go to R2 over S3. The playback Worker is only used for live playlists,
        and a one-off redeploy if bindings are missing.
      </p>
    </div>
  );
}
