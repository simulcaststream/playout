/**
 * Short-lived HMAC signatures for Worker-hosted segment URLs on gated events.
 *
 * Playlists require the viewer's session JWT; segment URLs instead carry
 * `?se=<epoch expiry>&sg=<base64url HMAC-SHA256(secret, pathname + "\n" + se)>`.
 * A copied manifest therefore stops working once its signatures expire, and the
 * session JWT never appears in segment request logs.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function signAssetPath(pathname: string, expiresAt: number, secret: string): Promise<string> {
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${pathname}\n${expiresAt}`));
	return base64UrlEncode(new Uint8Array(signature));
}

export async function signAssetUrl(absoluteUrl: string, expiresAt: number, secret: string): Promise<string> {
	const url = new URL(absoluteUrl);
	url.searchParams.set("se", String(expiresAt));
	url.searchParams.set("sg", await signAssetPath(url.pathname, expiresAt, secret));
	return url.toString();
}

export async function verifySignedAssetPath(
	pathname: string,
	expiresAt: number,
	signature: string,
	secret: string,
	now: number,
): Promise<boolean> {
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
	const expected = await signAssetPath(pathname, expiresAt, secret);
	return timingSafeEqual(expected, signature);
}
