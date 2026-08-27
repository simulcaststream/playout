import type { Phase, ReplayMode } from "./types.js";

export interface PhaseInput {
	now: number;
	scheduledStart: number;
	segmentDuration: number;
	totalSegments: number;
	replayMode: ReplayMode;
}

/** §4.1 — derive PRE_START | LIVE | ENDED from wall-clock elapsed time. */
export function computePhase(input: PhaseInput): Phase {
	const elapsed = input.now - input.scheduledStart;
	const totalDuration = input.totalSegments * input.segmentDuration;

	// loop mode never reaches ENDED; viewers keep cycling.
	if (input.replayMode === "loop") {
		return elapsed < 0 ? "pre_start" : "live";
	}

	if (elapsed < 0) return "pre_start";
	if (elapsed >= totalDuration) return "ended";
	return "live";
}
