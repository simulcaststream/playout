import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../env.js";
import { loadEvent, MalformedEventError } from "../lib/events.js";
import { SLUG_PATTERN } from "../middleware/event-loader.js";

type App = OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>;

/** Slug and token come from the URL — must never reach the HTML unescaped. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Format epoch seconds as UTC for the demo header. */
function formatEventTime(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function playerHtml(
	rawSlug: string,
	token: string,
	timing: { scheduledStart: number; durationSeconds: number } | null,
): string {
	const slug = escapeHtml(rawSlug);
	const tokenQs = token ? `?token=${encodeURIComponent(token)}` : "";
	const masterUrl = `/v1/events/${encodeURIComponent(rawSlug)}/master.m3u8${tokenQs}`;

	const timingHtml = timing
		? (() => {
				const start = timing.scheduledStart;
				const end = start + timing.durationSeconds;
				return `<span class="meta">start <strong>${escapeHtml(formatEventTime(start))}</strong></span>
    <span class="meta">end <strong>${escapeHtml(formatEventTime(end))}</strong></span>
    <span class="meta">${Math.round(timing.durationSeconds / 60)} min</span>`;
			})()
		: `<span class="meta">event record not in KV</span>`;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>simulated live: ${slug}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #0b0b0f;
      color: #e8e8ec;
      min-height: 100vh;
      padding: 16px;
    }
    .wrap {
      max-width: 640px;
      margin: 0 auto;
      border: 1px solid #222;
      border-radius: 8px;
      overflow: hidden;
      background: #111;
    }
    header {
      padding: 10px 14px;
      border-bottom: 1px solid #222;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: center;
      font-size: 13px;
    }
    header strong { color: #fff; }
    header .meta { color: #9aa0a6; }
    header .meta strong { color: #e8e8ec; font-weight: 600; }
    #quality {
      margin-left: auto;
      background: #1c1c24;
      color: #e8e8ec;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
    }
    main { display: flex; flex-direction: column; }
    video {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: 360px;
      background: #000;
    }
    video.live-locked::-webkit-media-controls-timeline,
    video.live-locked::-webkit-media-controls-current-time-display,
    video.live-locked::-webkit-media-controls-time-remaining-display {
      display: none !important;
    }
    #log {
      margin: 0;
      padding: 8px 14px;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #9aa0a6;
      border-top: 1px solid #222;
      max-height: 80px;
      overflow: auto;
    }
    a { color: #7eb8ff; }
  </style>
</head>
<body>
  <div class="wrap">
  <header>
    <strong>${slug}</strong>
    ${timingHtml}
    <a href="${masterUrl}" target="_blank" rel="noreferrer">master.m3u8</a>
    <select id="quality" hidden aria-label="Quality">
      <option value="-1">Auto</option>
    </select>
  </header>
  <main>
    <video id="v" class="live-locked" autoplay controls controlsList="nodownload noplaybackrate" playsinline muted></video>
    <pre id="log"></pre>
  </main>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"></script>
  <script>
    const masterUrl = ${JSON.stringify(masterUrl)};
    const video = document.getElementById('v');
    const logEl = document.getElementById('log');
    const qualityEl = document.getElementById('quality');

    function log(msg) {
      logEl.textContent = (new Date().toISOString().slice(11, 19) + ' ' + msg + '\\n') + logEl.textContent;
    }

    function lockToLiveEdge() {
      if (!video.seekable?.length) return;
      const end = video.seekable.end(video.seekable.length - 1);
      if (video.currentTime < end - 1.5) {
        video.currentTime = Math.max(0, end - 0.5);
      }
    }

    video.addEventListener('seeking', (e) => {
      if (e.isTrusted) lockToLiveEdge();
    });

    let playStarted = false;
    function tryPlay() {
      if (playStarted) return;
      video.muted = true;
      video.play().then(() => { playStarted = true; }).catch(() => {});
    }

    video.addEventListener('canplay', tryPlay);

    function levelLabel(level) {
      if (level.name) return level.name;
      if (level.height) return level.height + 'p';
      if (level.width) return level.width + 'w';
      return 'level ' + level.index;
    }

    function syncQualitySelect(hls) {
      if (hls.levels.length < 2) {
        qualityEl.hidden = true;
        return;
      }
      qualityEl.hidden = false;
      while (qualityEl.options.length > 1) qualityEl.remove(1);
      hls.levels.forEach((level, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = levelLabel(level);
        qualityEl.appendChild(opt);
      });
    }

    if (!window.Hls || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = masterUrl;
        log('native HLS -> ' + masterUrl);
      } else {
        log('HLS not supported in this browser');
      }
    } else {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        syncQualitySelect(hls);
        tryPlay();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const level = hls.levels[data.level];
        if (level) log('switched to ' + levelLabel(level));
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        log('fatal ' + data.type + ' / ' + data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log('network error — retrying in 2s');
          setTimeout(() => {
            hls.loadSource(masterUrl);
            hls.startLoad();
          }, 2000);
        }
      });
      qualityEl.addEventListener('change', () => {
        const level = Number(qualityEl.value);
        hls.currentLevel = level;
        log(level < 0 ? 'quality: auto' : 'quality: ' + qualityEl.selectedOptions[0].textContent);
      });
      hls.loadSource(masterUrl);
      hls.attachMedia(video);
      log('hls.js -> ' + masterUrl);
      window.hls = hls;
    }
  </script>
</body>
</html>`;
}

export function registerPlayerRoute(app: App): void {
	app.get("/player/:slug", async (c) => {
		const slug = c.req.param("slug");
		if (!SLUG_PATTERN.test(slug)) return c.text("Not Found", 404);
		const token = c.req.query("token") ?? "";

		let timing: { scheduledStart: number; durationSeconds: number } | null = null;
		try {
			const event = await loadEvent(c.env, slug);
			if (event) {
				timing = {
					scheduledStart: event.scheduledStart,
					durationSeconds: event.durationSeconds,
				};
			}
		} catch (err) {
			if (!(err instanceof MalformedEventError)) throw err;
		}

		// Always re-read KV on refresh after prep/set-start.sh (browsers otherwise cache HTML).
		c.header("Cache-Control", "no-store");
		return c.html(playerHtml(slug, token, timing));
	});
}
