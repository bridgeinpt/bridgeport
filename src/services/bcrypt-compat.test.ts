/**
 * Cross-version bcryptjs compatibility regression test (issue #166).
 *
 * BRIDGEPORT bumped `bcryptjs` 2.4.3 -> 3.0.3. bcryptjs v3 produces
 * `$2b$`-prefixed hashes by default, while password hashes already stored in
 * production/dev databases were minted by v2 and are `$2a$`-prefixed.
 *
 * Issue #166 acceptance criterion #1: all existing v2 password hashes MUST
 * still authenticate under v3 without re-hashing. This file locks that in.
 *
 * NOTE: Unlike `src/services/auth.test.ts`, this file deliberately does NOT
 * `vi.mock('bcryptjs')`. Its entire purpose is to exercise the *real* v3
 * implementation against a real v2-format hash. The unit vitest config runs
 * with `isolate: true`, so auth.test.ts's per-file bcrypt mock does not leak
 * here.
 */
import bcrypt from 'bcryptjs';
import { describe, it, expect } from 'vitest';

// Genuine v2-produced `$2a$` hash fixture.
//
// Produced with bcryptjs@2.4.3 (installed in a throwaway temp dir, then
// removed) via:
//   require('bcryptjs').hashSync('correct horse battery staple', 10)
// This is frozen as a literal so the test asserts true cross-version
// compatibility rather than re-deriving the hash with the installed v3.
const V2_PASSWORD = 'correct horse battery staple';
const V2_HASH_FIXTURE =
  '$2a$10$g0xLHBEqsQLkljS/hxJxse9QkgieJaoqG9pio4Sjs4fMVvw02JqqK';

describe('bcryptjs v2 -> v3 hash compatibility', () => {
  it('uses a genuine $2a$-prefixed (v2-format) fixture', () => {
    expect(V2_HASH_FIXTURE.startsWith('$2a$')).toBe(true);
  });

  it('validates a v2 $2a$ hash under v3 with the correct password', async () => {
    await expect(bcrypt.compare(V2_PASSWORD, V2_HASH_FIXTURE)).resolves.toBe(
      true
    );
  });

  it('rejects a wrong password against a v2 $2a$ hash under v3', async () => {
    await expect(
      bcrypt.compare('wrong-password', V2_HASH_FIXTURE)
    ).resolves.toBe(false);
  });

  it('round-trips a v3 hash (hash then compare) successfully', async () => {
    const password = 'password123';
    const hash = await bcrypt.hash(password, 10);

    await expect(bcrypt.compare(password, hash)).resolves.toBe(true);
    await expect(bcrypt.compare('not-the-password', hash)).resolves.toBe(false);
  });

  it('produces $2b$-prefixed hashes by default in v3', async () => {
    const hash = await bcrypt.hash('password123', 10);
    expect(hash.startsWith('$2b$')).toBe(true);
  });
});
