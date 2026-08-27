import type { Env, PendingLogin, SeatRecord, UserRecord } from "./types.js";
import { hashEmail } from "./jwt.js";

const USER_PREFIX = "user:";
const SEAT_PREFIX = "seat:";
const LOGIN_PREFIX = "login:";

export async function getUser(env: Env, email: string): Promise<UserRecord | null> {
	const key = USER_PREFIX + (await hashEmail(email));
	const raw = await env.LICENSE_DATA.get(key);
	if (!raw) return null;
	return JSON.parse(raw) as UserRecord;
}

export async function putUser(env: Env, user: UserRecord): Promise<void> {
	const key = USER_PREFIX + (await hashEmail(user.email));
	await env.LICENSE_DATA.put(key, JSON.stringify(user));
}

export async function getSeat(env: Env, userId: string): Promise<SeatRecord | null> {
	const raw = await env.LICENSE_DATA.get(SEAT_PREFIX + userId);
	if (!raw) return null;
	return JSON.parse(raw) as SeatRecord;
}

export async function putSeat(env: Env, seat: SeatRecord): Promise<void> {
	await env.LICENSE_DATA.put(SEAT_PREFIX + seat.userId, JSON.stringify(seat));
}

export async function deleteSeat(env: Env, userId: string): Promise<void> {
	await env.LICENSE_DATA.delete(SEAT_PREFIX + userId);
}

export async function putPendingLogin(env: Env, pending: PendingLogin): Promise<void> {
	const ttl = Math.max(60, pending.exp - Math.floor(Date.now() / 1000));
	await env.LICENSE_DATA.put(LOGIN_PREFIX + pending.token, JSON.stringify(pending), { expirationTtl: ttl });
}

export async function consumePendingLogin(env: Env, token: string): Promise<PendingLogin | null> {
	const raw = await env.LICENSE_DATA.get(LOGIN_PREFIX + token);
	if (!raw) return null;
	await env.LICENSE_DATA.delete(LOGIN_PREFIX + token);
	return JSON.parse(raw) as PendingLogin;
}

export function graceSeconds(env: Env): number {
	return Number(env.HEARTBEAT_GRACE_HOURS || "72") * 3600;
}

export function transferCooldownSeconds(env: Env): number {
	return Number(env.TRANSFER_COOLDOWN_DAYS || "7") * 86400;
}

export function licenseTtlSeconds(env: Env): number {
	return Number(env.LICENSE_TTL_DAYS || "7") * 86400;
}

export async function userIdForEmail(email: string): Promise<string> {
	return hashEmail(email);
}
