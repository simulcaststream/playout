import { computePhase } from "./phase.js";
import type { Phase, ReplayMode } from "./types.js";

export interface CacheMaxAgeInput {
	now: number;
	scheduledStart: number;
	segmentDuration: number;
	totalSegments: number;
	replayMode: ReplayMode;
	phase?: Phase;
}

export interface CacheMaxAgeResult {
	maxAge?: number;
	staleWhileRevalidate?: number;
	immutable?: boolean;
	noStore?: boolean;
}

/** Playlists are dynamic — avoid browser caching (stale tail/ended manifests after set-start). */
export function computeCacheMaxAge(input: CacheMaxAgeInput): CacheMaxAgeResult {
	const phase = input.phase ?? computePhase(input);

	if (phase === "pre_start" || phase === "live") {
		return { noStore: true };
	}

	if (phase === "ended" && input.replayMode === "vod") {
		return { maxAge: 3600, immutable: true };
	}

	return { noStore: true };
}

export function formatCacheControl(result: CacheMaxAgeResult): string {
	if (result.noStore) return "no-store";
	const parts = [`public, max-age=${result.maxAge ?? 0}`];
	if (result.staleWhileRevalidate !== undefined) {
		parts.push(`stale-while-revalidate=${result.staleWhileRevalidate}`);
	}
	if (result.immutable) {
		parts.push("immutable");
	}
	return parts.join(", ");
}

/**
 * Cache-Control for the shared edge copy (Cache API). Must be cacheable —
 * `no-store` responses are rejected by `cache.put`. Safe because the cache key
 * rotates every segment boundary (see mediaPlaylistCacheBucket); the TTL only
 * bounds how long an already-superseded bucket lingers.
 */
export function edgeCacheControl(phase: Phase, replayMode: ReplayMode, segmentDuration: number): string {
	if (phase === "ended" && replayMode === "vod") return "public, max-age=3600, immutable";
	if (phase === "live") return `public, max-age=${Math.max(1, Math.ceil(segmentDuration))}`;
	return "no-store";
}

/**
 * Cache API key bucket: one entry per segment boundary per slug/rendition.
 * Clamped once the event ends (non-loop) so ENDED playlists share a single key
 * instead of minting a new one every segmentDuration forever.
 */
export function mediaPlaylistCacheBucket(
	now: number,
	scheduledStart: number,
	segmentDuration: number,
	totalSegments: number,
	replayMode: ReplayMode,
): number {
	const elapsed = Math.max(0, now - scheduledStart);
	const bucket = Math.floor(elapsed / segmentDuration);
	if (replayMode === "loop") return bucket;
	return Math.min(bucket, totalSegments);
}
