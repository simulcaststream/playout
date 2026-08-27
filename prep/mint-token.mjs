#!/usr/bin/env node
/**
 * Mint dev tokens for testing gated events.
 *
 * Session JWT (what the control plane issues in production):
 *   node prep/mint-token.mjs demo                  # scoped to slug "demo", 1h expiry
 *   node prep/mint-token.mjs demo --ttl 7200       # 2h expiry
 *   node prep/mint-token.mjs demo --no-slug        # unscoped (opens every gated event)
 *   node prep/mint-token.mjs demo --expired        # already expired (negative test)
 *
 * Signed segment URL (what createUrlSigner stamps into playlists):
 *   node prep/mint-token.mjs demo --sign /v1/assets/demo/video/720p/seg_00001.m4s
 *   node prep/mint-token.mjs demo --sign <path> --sign-ttl 5     # dies in 5s
 *   node prep/mint-token.mjs demo --sign <path> --sign-ttl -60   # already dead
 *
 * Secret resolution: --secret flag > SESSION_JWT_SECRET env > .dev.vars file.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readDevVarsSecret() {
	const path = join(__dirname, "..", ".dev.vars");
	if (!existsSync(path)) return undefined;
	const match = readFileSync(path, "utf8").match(/^SESSION_JWT_SECRET=(.+)$/m);
	return match?.[1]?.trim();
}

const args = process.argv.slice(2);
const slug = args[0] && !args[0].startsWith("--") ? args[0] : "demo";
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : (args[i + 1] ?? true)) : undefined;
};

const secret = flag("--secret") ?? process.env.SESSION_JWT_SECRET ?? readDevVarsSecret();
if (!secret || secret === true) {
	console.error("no secret — pass --secret, set SESSION_JWT_SECRET, or add it to .dev.vars");
	process.exit(1);
}

const b64u = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);

const signPath = flag("--sign");
if (typeof signPath === "string") {
	// HMAC-signed segment URL — must match src/lib/asset-sign.ts exactly.
	const ttl = Number(flag("--sign-ttl") ?? 300);
	const se = now + ttl;
	const sg = createHmac("sha256", secret).update(`${signPath}\n${se}`).digest("base64url");
	console.log(`http://localhost:8787${signPath}?se=${se}&sg=${sg}`);
	process.exit(0);
}

// Session JWT — must match src/middleware/gate.ts verifyJwt.
const ttl = flag("--expired") ? -60 : Number(flag("--ttl") ?? 3600);
const payload = { sub: "dev-viewer", exp: now + ttl };
if (!flag("--no-slug")) payload.slug = slug;

const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const body = b64u(JSON.stringify(payload));
const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
console.log(`${header}.${body}.${sig}`);
