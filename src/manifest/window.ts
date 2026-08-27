import { computePhase } from "./phase.js";
import type { Phase, ReplayMode, WindowResult } from "./types.js";

export interface WindowInput {
	now: number;
	scheduledStart: number;
	segmentDuration: number;
	totalSegments: number;
	windowSize: number;
	joinFromStart: boolean;
	replayMode: ReplayMode;
}

/** §4.2 — index of the newest segment that has "aired" (clamped to N-1). */
export function computeLiveEdgeIndex(
	elapsed: number,
	segmentDuration: number,
	totalSegments: number,
	replayMode: ReplayMode,
): number {
	const S = segmentDuration;
	const N = totalSegments;
	const totalDuration = N * S;

	if (replayMode === "loop" && elapsed >= 0) {
		// §4.5 — wrap elapsed time so the edge cycles back to segment 0.
		const loopElapsed = elapsed % totalDuration;
		return Math.min(Math.floor(loopElapsed / S), N - 1);
	}

	// §4.2 — floor division gives the segment whose air-time has begun.
	return Math.min(Math.floor(elapsed / S), N - 1);
}

/** §4.3–4.6 — map wall-clock time to the segment window and playlist metadata. */
export function computeWindow(input: WindowInput): WindowResult {
	const S = input.segmentDuration;
	const N = input.totalSegments;
	const W = input.windowSize;
	const elapsed = input.now - input.scheduledStart;
	const phase = computePhase(input);

	// §4.6 — holding playlist: valid header, zero segments, no ENDLIST.
	if (phase === "pre_start") {
		return {
			phase,
			windowStart: 0,
			windowEnd: -1,
			mediaSequence: 0,
			liveEdgeIndex: -1,
			endList: false,
		};
	}

	// §4.5 loop — absolute (non-wrapping) indices keep MEDIA-SEQUENCE monotonic
	// across cycles; the renderer maps index % N onto segment files and emits
	// EXT-X-DISCONTINUITY at each seam. joinFromStart is ignored in loop mode.
	if (input.replayMode === "loop") {
		const absoluteEdge = Math.floor(elapsed / S);
		const windowStart = Math.max(0, absoluteEdge - W + 1);
		return {
			phase: "live",
			windowStart,
			windowEnd: absoluteEdge,
			mediaSequence: windowStart,
			liveEdgeIndex: absoluteEdge % N,
			wrapEvery: N,
			// Seams before index k*N (k >= 1) that have rolled out of the window.
			discontinuitySequence: Math.floor(windowStart / N),
			endList: false,
		};
	}

	const liveEdgeIndex = computeLiveEdgeIndex(elapsed, S, N, input.replayMode);

	// §4.5 vod — full on-demand playlist once the event ends.
	if (phase === "ended" && input.replayMode === "vod") {
		return {
			phase,
			windowStart: 0,
			windowEnd: N - 1,
			mediaSequence: 0,
			liveEdgeIndex: N - 1,
			playlistType: "VOD",
			endList: true,
		};
	}

	// §4.5 none — stream is over; no replay (routes return 404, same as pre_start).
	if (phase === "ended" && input.replayMode === "none") {
		return {
			phase,
			windowStart: 0,
			windowEnd: -1,
			mediaSequence: 0,
			liveEdgeIndex: N - 1,
			endList: true,
		};
	}

	// §4.4 — EVENT playlist grows from segment 0 as the live edge advances.
	if (input.joinFromStart) {
		return {
			phase: "live",
			windowStart: 0,
			windowEnd: liveEdgeIndex,
			mediaSequence: 0,
			liveEdgeIndex,
			playlistType: "EVENT",
			endList: liveEdgeIndex === N - 1,
		};
	}

	// §4.3 — sliding window anchored at the live edge.
	const windowStart = Math.max(0, liveEdgeIndex - W + 1);

	return {
		phase: "live",
		windowStart,
		windowEnd: liveEdgeIndex,
		mediaSequence: windowStart,
		liveEdgeIndex,
		endList: liveEdgeIndex === N - 1,
	};
}
