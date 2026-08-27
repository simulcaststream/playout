import type { EventRecord } from "../manifest/types.js";
import { EventRecordSchema } from "../manifest/types.js";

export async function loadEvent(env: Env, slug: string): Promise<EventRecord | null> {
	const raw = await env.LIVE_EVENT_RECORDS.get(slug);
	if (!raw) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MalformedEventError(slug);
	}

	const result = EventRecordSchema.safeParse(parsed);
	if (!result.success) {
		throw new MalformedEventError(slug, result.error.message);
	}

	return result.data;
}

export class MalformedEventError extends Error {
	constructor(
		public readonly slug: string,
		details?: string,
	) {
		super(details ? `Malformed event record for "${slug}": ${details}` : `Malformed event record for "${slug}"`);
		this.name = "MalformedEventError";
	}
}
