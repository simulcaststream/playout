/** Decode base64url to bytes. */
function base64UrlDecode(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export interface SessionClaims {
	exp?: number;
	/** Optional event binding — when present, the token only opens that slug. */
	slug?: string;
}

export async function verifyJwt(token: string, secret: string): Promise<SessionClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [headerB64, payloadB64, signatureB64] = parts;
	let header: { alg?: string };
	let payload: SessionClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
		payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
	} catch {
		return null;
	}

	// Only HS256 is issued; reject alg confusion ("none", RS256, …) outright.
	if (header.alg !== "HS256") return null;

	if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
		return null;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = base64UrlDecode(signatureB64);
	const valid = await crypto.subtle.verify("HMAC", key, signature, data);
	return valid ? payload : null;
}
