/**
 * Bunny CDN Token Authentication.
 * token = base64url( SHA256( securityKey + urlPath + expires ) )
 * @see https://docs.bunny.net/docs/cdn-token-authentication
 */
export async function signCdnUrl(
	absoluteUrl: string,
	expiresAt: number,
	securityKey: string,
): Promise<string> {
	const url = new URL(absoluteUrl);
	const path = url.pathname;
	const payload = securityKey + path + String(expiresAt);

	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
	const token = base64UrlEncode(new Uint8Array(digest));

	url.searchParams.set("token", token);
	url.searchParams.set("expires", String(expiresAt));
	return url.toString();
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Paid-gate helper: sign CDN URLs with a TTL comfortably beyond the live window. */
export function cdnUrlExpiry(now: number, windowSeconds: number): number {
	return Math.ceil(now + windowSeconds + 3600);
}
