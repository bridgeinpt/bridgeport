/**
 * Side-effect bootstrap for the OpenAPI dump: provides stable defaults for the
 * env vars `src/lib/config.ts` requires, so the dump can build the app without
 * a real `.env`. Imported FIRST by `openapi-dump.ts` (before any module that
 * reads config), because ESM evaluates imports top-to-bottom.
 *
 * These are throwaway values — no secrets are decrypted during a spec dump and
 * the generated spec does not depend on them.
 */
// A valid 32-byte (base64-encoded) key, as `initializeCrypto` requires. We
// always set it (not `||=`) so the dump succeeds even when CI exports a
// non-32-byte placeholder MASTER_KEY — the dump never decrypts real data.
process.env.MASTER_KEY = 'ilyS3JROhJmj8QEYHuoZts8aoK2LG9SHl0EgIn0gsVw=';
process.env.JWT_SECRET ||= 'openapi-dump-jwt-secret-not-real';
