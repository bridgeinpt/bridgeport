import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  isDryRun,
  redactSecretValues,
  redactEnvSecrets,
  unifiedDiff,
} from './dry-run.js';

/**
 * Unit tests for the dry-run helpers (issue #128).
 *
 * Coverage focus:
 *  - `isDryRun`     : strict equality on the literal `"true"` for both the
 *                     `?dryRun=true` query and the `X-Dry-Run: true` header,
 *                     so a typo or boolean coercion can't accidentally trigger
 *                     dry-run mode in production.
 *  - `redactSecretValues` / `redactEnvSecrets`
 *                   : secret VALUES (not keys, not `${KEY}` references) are
 *                     replaced with `***`, with longest-first ordering so a
 *                     value that is a substring of another doesn't truncate
 *                     the longer one mid-way. Empty secrets are skipped (so
 *                     `String.replaceAll('', '***')` can't explode the input).
 *  - `unifiedDiff`  : identical strings return `''`, otherwise the result
 *                     follows the `--- / +++ / @@` form with `-`/`+`/` `
 *                     prefixes per line.
 */

/**
 * Build a minimal FastifyRequest-shaped object for `isDryRun` to consume.
 * The function reads only `request.query` and `request.headers` so this is
 * sufficient — we don't need the full Fastify request surface.
 */
function makeRequest(opts: {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): FastifyRequest {
  return {
    query: opts.query ?? {},
    headers: opts.headers ?? {},
  } as unknown as FastifyRequest;
}

describe('isDryRun', () => {
  it('returns true for `?dryRun=true`', () => {
    expect(isDryRun(makeRequest({ query: { dryRun: 'true' } }))).toBe(true);
  });

  it('returns true for `X-Dry-Run: true` (Fastify normalizes header names to lowercase)', () => {
    // Fastify exposes headers under their lowercased name regardless of the
    // case the client sent. The implementation reads `headers['x-dry-run']`,
    // which is the canonical Fastify form.
    expect(isDryRun(makeRequest({ headers: { 'x-dry-run': 'true' } }))).toBe(true);
  });

  it('query param wins when both query and header are present', () => {
    // Both forms trigger dry-run mode; this just documents that the function
    // doesn't combine them in a weird way (e.g. requiring both, XOR-ing).
    expect(
      isDryRun(
        makeRequest({
          query: { dryRun: 'true' },
          headers: { 'x-dry-run': 'true' },
        })
      )
    ).toBe(true);
  });

  it('returns false when the query param is absent and no header is set', () => {
    expect(isDryRun(makeRequest({}))).toBe(false);
  });

  it('returns false for `?dryRun=false`', () => {
    expect(isDryRun(makeRequest({ query: { dryRun: 'false' } }))).toBe(false);
  });

  it('returns false for `?dryRun=1` (strict literal match — not truthiness)', () => {
    // The implementation deliberately compares to the literal "true" so a
    // typo or boolean coercion can't accidentally trigger dry-run mode.
    expect(isDryRun(makeRequest({ query: { dryRun: '1' } }))).toBe(false);
  });

  it('returns false for `?dryRun=TRUE` (case-sensitive value match)', () => {
    expect(isDryRun(makeRequest({ query: { dryRun: 'TRUE' } }))).toBe(false);
  });

  it('returns false when the query value is empty', () => {
    expect(isDryRun(makeRequest({ query: { dryRun: '' } }))).toBe(false);
  });

  it('returns false when the query value is a non-string (e.g. boolean true)', () => {
    // Express/Fastify query parsers normally yield strings, but if some
    // upstream coerces the value to a real boolean the function must still
    // refuse to trigger dry-run mode.
    expect(isDryRun(makeRequest({ query: { dryRun: true as unknown as string } }))).toBe(false);
  });

  it('returns false for `X-Dry-Run: false`', () => {
    expect(isDryRun(makeRequest({ headers: { 'x-dry-run': 'false' } }))).toBe(false);
  });

  it('does not look at the capitalized header form (Fastify normalizes; client casing is ignored)', () => {
    // Fastify always exposes lowercase header names. If someone hand-rolls a
    // request with the uppercase key, the function intentionally won't match
    // it — that scenario only matters in tests because Fastify never produces
    // such a request at runtime.
    expect(isDryRun(makeRequest({ headers: { 'X-Dry-Run': 'true' } }))).toBe(false);
  });
});

describe('redactSecretValues', () => {
  it('replaces every occurrence of a secret value with ***', () => {
    const out = redactSecretValues('token=hunter2 retry=hunter2', ['hunter2']);
    expect(out).toBe('token=*** retry=***');
  });

  it('leaves `${KEY}` references untouched (only VALUES are redacted)', () => {
    // The whole point of redaction is to scrub the resolved secret value out
    // of the rendered output. The `${KEY}` placeholders in the source
    // template are not sensitive (they don't contain the value) — they help
    // operators see which keys are referenced.
    const content = 'password=${DB_PASSWORD}\ntoken=${API_TOKEN}';
    const out = redactSecretValues(content, ['s3cr3t', 'tk-xyz']);
    expect(out).toBe(content);
  });

  it('handles overlapping substrings by replacing the longest value first', () => {
    // `foo` is a substring of `foobar`. If `foo` were replaced first we'd get
    // "***bar" out of "foobar" — losing the longer match. Longest-first
    // ordering avoids that.
    expect(redactSecretValues('foobar foo', ['foo', 'foobar'])).toBe('*** ***');
  });

  it('returns the input unchanged when the secrets array is empty', () => {
    expect(redactSecretValues('nothing-to-redact', [])).toBe('nothing-to-redact');
  });

  it('skips empty-string secret values (otherwise replaceAll would explode the input)', () => {
    // String.prototype.replaceAll('', '***') injects `***` between every
    // character of the input. The implementation filters out empty values
    // BEFORE doing the sort/replace to avoid this footgun.
    const out = redactSecretValues('abc', ['', 'b']);
    expect(out).toBe('a***c');
  });

  it('returns the input unchanged when the input is empty', () => {
    expect(redactSecretValues('', ['x'])).toBe('');
  });

  it('treats secret values as literal strings (no regex metacharacter interpretation)', () => {
    // The implementation uses split/join, not RegExp, so secret values
    // containing regex metacharacters do not need to be escaped — they match
    // literally.
    const out = redactSecretValues('a.b a.b a*b', ['a.b']);
    expect(out).toBe('*** *** a*b');
  });
});

describe('redactEnvSecrets', () => {
  it('redacts values that match a secret', () => {
    const out = redactEnvSecrets({ API_TOKEN: 's3cr3t', DEBUG: 'true' }, ['s3cr3t']);
    expect(out).toEqual({ API_TOKEN: '***', DEBUG: 'true' });
  });

  it('preserves non-secret values unchanged', () => {
    const out = redactEnvSecrets(
      { PORT: '3000', HOST: 'localhost', PATH: '/usr/local/bin' },
      ['s3cr3t']
    );
    expect(out).toEqual({ PORT: '3000', HOST: 'localhost', PATH: '/usr/local/bin' });
  });

  it('returns an empty object when given an empty env', () => {
    expect(redactEnvSecrets({}, ['s3cr3t'])).toEqual({});
  });

  it('does not mutate the input object', () => {
    const input = { API_TOKEN: 's3cr3t' };
    redactEnvSecrets(input, ['s3cr3t']);
    expect(input).toEqual({ API_TOKEN: 's3cr3t' });
  });

  it('redacts secrets even when a value contains the secret as a substring', () => {
    // The merged env may include vars whose value embeds the secret (e.g.
    // a DATABASE_URL that contains the password). Substring replacement is
    // intentional so those leaks are caught too.
    const out = redactEnvSecrets(
      { DATABASE_URL: 'postgres://user:s3cr3t@host/db', DEBUG: 'true' },
      ['s3cr3t']
    );
    expect(out).toEqual({ DATABASE_URL: 'postgres://user:***@host/db', DEBUG: 'true' });
  });
});

describe('unifiedDiff', () => {
  it('returns an empty string when both sides are identical', () => {
    expect(unifiedDiff('same\ncontent\n', 'same\ncontent\n')).toBe('');
  });

  it('emits a diff with --- / +++ / @@ headers when contents differ', () => {
    const out = unifiedDiff('a\nb\n', 'a\nc\n', { fromLabel: 'before.txt', toLabel: 'after.txt' });
    // Headers must reflect the labels passed in.
    expect(out).toContain('--- before.txt');
    expect(out).toContain('+++ after.txt');
    // Hunk header: line counts come from split('\n') length (3 each: 'a','b','').
    expect(out).toContain('@@ -1,3 +1,3 @@');
    // The removed line is prefixed with `-`, the added one with `+`.
    expect(out).toContain('-b');
    expect(out).toContain('+c');
  });

  it('uses default labels when none are provided', () => {
    const out = unifiedDiff('a', 'b');
    expect(out).toContain('--- current');
    expect(out).toContain('+++ rendered');
  });

  it('represents a full replacement as all `-` then all `+` lines', () => {
    const out = unifiedDiff('old\n', 'new\n');
    const lines = out.split('\n');
    // 'old\n'.split('\n') → ['old', ''] (2 lines). Same for 'new\n'.
    expect(lines).toContain('-old');
    expect(lines).toContain('+new');
    // The trailing empty-string line is common to both and shows up as a
    // context line (no prefix or ` `-prefix).
  });

  it('emits `+` lines for appended content (empty `before`)', () => {
    const out = unifiedDiff('', 'one\ntwo\n');
    expect(out).toContain('+one');
    expect(out).toContain('+two');
    // No `-`-prefixed content lines (we skip the `--- header` line, which is
    // diff metadata, not a removed line).
    const contentLines = out
      .split('\n')
      .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && !l.startsWith('@@'));
    expect(contentLines.some((l) => l.startsWith('-'))).toBe(false);
  });

  it('emits `-` lines for fully deleted content (empty `after`)', () => {
    const out = unifiedDiff('one\ntwo\n', '');
    expect(out).toContain('-one');
    expect(out).toContain('-two');
    // No `+`-prefixed content lines (we skip the `+++ header` line).
    const contentLines = out
      .split('\n')
      .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && !l.startsWith('@@'));
    expect(contentLines.some((l) => l.startsWith('+'))).toBe(false);
  });

  it('returns empty diff when both sides are empty (no difference)', () => {
    expect(unifiedDiff('', '')).toBe('');
  });

  it('preserves order: context lines stay where they belong relative to the changes', () => {
    // a / b / c → a / X / c
    // The `b` line should be removed and `X` added between the `a` and `c`
    // context lines. Verifying the relative ordering protects against an
    // LCS regression that would reorder context.
    const out = unifiedDiff('a\nb\nc', 'a\nX\nc');
    const lines = out.split('\n');
    const idxA = lines.indexOf(' a');
    const idxMinusB = lines.indexOf('-b');
    const idxPlusX = lines.indexOf('+X');
    const idxC = lines.indexOf(' c');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxMinusB).toBeGreaterThan(idxA);
    expect(idxPlusX).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxMinusB);
    expect(idxC).toBeGreaterThan(idxPlusX);
  });
});
