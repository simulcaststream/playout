/** Optional secrets and vars (not emitted by `wrangler types`). */
interface Env {
	SESSION_JWT_SECRET?: string;
	OPERATOR_SECRET?: string;
	BUNNY_TOKEN_KEY?: string;
	CORS_ORIGINS?: string;
	SEGMENTS: R2Bucket;
}
