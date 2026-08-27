import { verifyJwt } from "./session-jwt.js";

/** HttpOnly session cookie set by the paywall on the Worker domain (or parent). */
export const SESSION_COOKIE_NAME = "cl_session";

/**
 * Parse a Cookie header and return the session JWT value, if present.
 * Does not validate the token — use {@link verifySessionCookie} for that.
 */
export function getSessionJwtFromCookie(cookieHeader: string | undefined): string | null {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
		const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1);
		return value ? decodeURIComponent(value) : null;
	}

	return null;
}

/** Read and verify the session cookie against SESSION_JWT_SECRET. */
export async function verifySessionCookie(
	cookieHeader: string | undefined,
	secret: string,
): Promise<import("./session-jwt.js").SessionClaims | null> {
	const token = getSessionJwtFromCookie(cookieHeader);
	if (!token) return null;
	return verifyJwt(token, secret);
}
