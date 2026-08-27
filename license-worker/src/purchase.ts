import type { Env, UserRecord } from "./types.js";
import { getUser, putUser } from "./store.js";

export async function markUserPaid(
	env: Env,
	email: string,
	purchaseId: string,
): Promise<UserRecord> {
	const normalized = email.trim().toLowerCase();
	const existing = await getUser(env, normalized);
	const user: UserRecord =
		existing ?? {
			email: normalized,
			paid: true,
			purchaseId,
			createdAt: Math.floor(Date.now() / 1000),
		};
	user.paid = true;
	user.purchaseId = purchaseId;
	await putUser(env, user);
	return user;
}
