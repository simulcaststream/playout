import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import BrandMark from "../components/BrandMark";

type Props = { onDone: () => void };

export default function LoginPage({ onDone }: Props) {
  const [email, setEmail] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [magicUrl, setMagicUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"email" | "token">("email");

  async function requestLogin() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ ok: boolean; magicUrl?: string; token?: string; message?: string }>(
        "license_request_login",
        { email },
      );
      if (res.magicUrl) setMagicUrl(res.magicUrl);
      if (res.token) setLoginToken(res.token);
      setStep("token");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyLogin() {
    setBusy(true);
    setError(null);
    try {
      await invoke("license_verify_login", { token: loginToken });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      await invoke("license_create_checkout", { email: email || "you@example.com" });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function devLogin() {
    setBusy(true);
    setError(null);
    try {
      await invoke("license_dev_login", { email: email || "dev@example.com" });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <BrandMark />
      <h1>Sign in</h1>
      <p>Purchase required ($49). Pay with Stripe, then sign in with the email you used at checkout.</p>
      {step === "email" && (
        <>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <div className="row">
            <button type="button" className="primary" disabled={busy || !email} onClick={() => void requestLogin()}>
              Send magic link
            </button>
            <button type="button" className="secondary" disabled={busy || !email} onClick={() => void startCheckout()}>
              Buy with Stripe ($49)
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void devLogin()}>
              Dev login
            </button>
          </div>
        </>
      )}
      {step === "token" && (
        <>
          {magicUrl && (
            <p className="mono">
              Magic link: {magicUrl}
              <br />
              Paste the token from the link below if the app did not open automatically.
            </p>
          )}
          <label>
            Login token
            <input value={loginToken} onChange={(e) => setLoginToken(e.target.value)} placeholder="paste token" />
          </label>
          <button type="button" className="primary" disabled={busy || !loginToken} onClick={() => void verifyLogin()}>
            Activate this device
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
