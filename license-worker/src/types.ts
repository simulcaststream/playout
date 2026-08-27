export interface Env {
	LICENSE_DATA: KVNamespace;
	LICENSE_JWT_SECRET: string;
	WEBHOOK_SECRET?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_PRICE_ID?: string;
	STRIPE_AMOUNT_CENTS?: string;
	STRIPE_CURRENCY?: string;
	STRIPE_SUCCESS_URL?: string;
	STRIPE_CANCEL_URL?: string;
	RESEND_API_KEY?: string;
	ALLOW_DEV_LOGIN?: string;
	APP_URL: string;
	LICENSE_TTL_DAYS: string;
	HEARTBEAT_GRACE_HOURS: string;
	TRANSFER_COOLDOWN_DAYS: string;
}

export interface UserRecord {
	email: string;
	paid: boolean;
	purchaseId?: string;
	createdAt: number;
}

export interface SeatRecord {
	userId: string;
	deviceId: string;
	activatedAt: number;
	lastSeen: number;
	lastTransferAt?: number;
}

export interface LicenseClaims {
	sub: string;
	email: string;
	deviceId: string;
	exp: number;
	iat: number;
}

export interface PendingLogin {
	email: string;
	token: string;
	exp: number;
}
