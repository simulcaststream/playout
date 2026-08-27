#!/usr/bin/env node
/**
 * Bundle the HLS manifest Worker for desktop deployment via Cloudflare API.
 * Output: desktop/src-tauri/resources/worker/
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "desktop/src-tauri/resources/worker");
const staging = join(root, ".worker-bundle-staging");

rmSync(outDir, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(staging, { recursive: true });

// wrangler bundles the worker + metadata for upload
execSync("pnpm exec wrangler deploy --dry-run --outdir " + staging, {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "dry-run" },
});

const candidates = ["index.js", "worker.js", "calculated-live-manifest.js"];
let bundled = null;
for (const name of candidates) {
	const p = join(staging, name);
	if (existsSync(p)) {
		bundled = p;
		break;
	}
}
if (!bundled) {
	const files = execSync("find " + staging + " -name '*.js' -type f", { encoding: "utf8" })
		.trim()
		.split("\n")
		.filter(Boolean);
	if (files.length === 0) {
		console.error("no bundled worker found in", staging);
		process.exit(1);
	}
	bundled = files[0];
}

cpSync(bundled, join(outDir, "index.js"));
if (existsSync(join(staging, "index.js.map"))) {
	cpSync(join(staging, "index.js.map"), join(outDir, "index.js.map"));
}

console.log("worker bundle ->", join(outDir, "index.js"));
