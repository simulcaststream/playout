import type { EventRecord, Gate } from "./manifest/types.js";

export type AppVariables = {
	event?: EventRecord;
	gate?: Gate;
};
