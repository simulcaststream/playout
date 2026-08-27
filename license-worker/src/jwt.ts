import type { LicenseClaims } from "./types.js";

function b64uEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signLicenseJwt(claims: LicenseClaims, secret: string): Promise<string> {
	const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const body = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
	const data = new TextEncoder().encode(`${header}.${body}`);
	const key = await importKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, data);
	return `${header}.${body}.${b64uEncode(new Uint8Array(sig))}`;
}

export async function verifyLicenseJwt(token: string, secret: string): Promise<LicenseClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [headerB64, payloadB64, signatureB64] = parts;
	let header: { alg?: string };
	let payload: LicenseClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(b64uDecode(headerB64)));
		payload = JSON.parse(new TextDecoder().decode(b64uDecode(payloadB64)));
	} catch {
		return null;
	}
	if (header.alg !== "HS256") return null;
	if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
	if (!payload.email || !payload.deviceId) return null;

	const key = await importKey(secret);
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const sig = b64uDecode(signatureB64);
	const valid = await crypto.subtle.verify("HMAC", key, sig, data);
	return valid ? payload : null;
}

export function randomToken(bytes = 32): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return b64uEncode(arr);
}

export async function hashEmail(email: string): Promise<string> {
	const data = new TextEncoder().encode(email.toLowerCase().trim());
	const hash = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
