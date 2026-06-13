/**
 * MCP secret-redactor — defense-in-depth at the protocol boundary (issue #208).
 *
 * Every tool output and every resource read is funneled through `redactSensitive`
 * before it leaves the MCP server. This GUARANTEES that no field holding secret
 * material (encrypted ciphertext, encryption nonces/IVs, token hashes, raw SSH /
 * agent tokens) is ever serialized to a client — independent of how the backing
 * REST route happens to behave. Even if a route regresses and starts returning a
 * raw Prisma row, the redactor strips the secret-named columns here.
 *
 * The denylist is derived from `prisma/schema.prisma`: every encrypted column,
 * every paired nonce/IV column, plus the unhashed credential columns that aren't
 * `encrypted`-prefixed (`sshPrivateKey`, `agentToken`, `tokenHash`). It is applied
 * by KEY NAME, recursively, into nested objects and arrays.
 *
 * IMPORTANT — we deliberately KEEP the non-secret metadata booleans/strings the
 * safe API projections expose (`hasToken`, `hasPassword`, `hasSecret`,
 * `hasCredentials`, `tokenPrefix`): these reveal only presence, never the value,
 * and the read tools advertise them as their contract. The matchers below are
 * scoped so they never strip these.
 */

/**
 * Exact secret-bearing column names found in prisma/schema.prisma. Stripped by
 * exact key match. (The pattern matchers below catch most of these too, but the
 * explicit set documents the audited inventory and covers names the patterns
 * miss — e.g. the lower-case `nonce` on Secret, and the non-`encrypted`-prefixed
 * `sshPrivateKey` / `agentToken` / `tokenHash`.)
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  // Environment
  'sshPrivateKey',
  // Server
  'agentToken',
  // ApiToken
  'tokenHash',
  // Secret
  'encryptedValue',
  'nonce',
  // RegistryConnection
  'encryptedToken',
  'tokenNonce',
  'encryptedPassword',
  'passwordNonce',
  // Database
  'encryptedCredentials',
  'credentialsNonce',
  // WebhookSubscription / WebhookConfig / SmtpConfig
  'encryptedSecret',
  'secretNonce',
  // SpacesConfig
  'encryptedSecretKey',
  'secretKeyNonce',
  // SlackChannel
  'webhookUrlNonce',
]);

/**
 * Pattern matchers (case-insensitive) for secret-bearing key shapes, so a future
 * encrypted/nonce column added to the schema is stripped without touching this
 * file:
 *   - `^encrypted` — any `encrypted*` ciphertext column.
 *   - `nonce$`     — any `*Nonce` / `*nonce` IV column (also bare `nonce`).
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [/^encrypted/i, /nonce$/i];

/**
 * `true` iff `key` names a secret-bearing field that must be removed. Matches the
 * exact denylist OR any of the shape patterns. The non-secret `has*` / `tokenPrefix`
 * metadata never matches (no `encrypted` prefix, no `nonce` suffix, not in the set).
 */
export function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true;
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Recursively strip secret-bearing keys from a JSON-serializable value, returning
 * a redacted copy. Recurses into nested objects and arrays; primitives, `null`,
 * and `Date`s pass through unchanged. The input is not mutated.
 */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as unknown as T;
  }
  // Plain objects only — leave Date and other class instances intact (they have
  // no secret columns and stringify to scalars).
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      out[key] = redactSensitive(v);
    }
    return out as unknown as T;
  }
  return value;
}
