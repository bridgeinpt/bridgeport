import { describe, it, expect } from 'vitest';
import { composeFragmentedContent, languageSupportsHashHeaders } from './config-fragments.js';

/**
 * Unit tests for `composeFragmentedContent` — the pure helper that builds the
 * effective ConfigFile content by concatenating fragment contents (in caller
 * order) and the ConfigFile's own content, with `#`-comment headers between
 * sections when the language supports them.
 *
 * The function is intentionally tiny but it's a load-bearing piece of the
 * fragments feature: every render path (compose, sync live, sync dry-run,
 * preview) routes through here. The byte-for-byte additive contract on the
 * no-fragments case is what guarantees the feature is backwards-compatible.
 */
describe('composeFragmentedContent', () => {
  describe('empty fragments contract (back-compat)', () => {
    it('returns the own content byte-for-byte unchanged when no fragments are given', () => {
      // Critical invariant: a ConfigFile with no fragments must render
      // identically to today. No header, no leading newline, no trimming.
      const own = 'KEY=value\nOTHER=value\n';
      expect(composeFragmentedContent([], own, 'env')).toBe(own);
    });

    it('preserves an empty own content as the empty string', () => {
      expect(composeFragmentedContent([], '', 'env')).toBe('');
    });

    it('preserves trailing whitespace exactly when no fragments are present', () => {
      // The composer is purely additive — the downstream `.trimEnd()` in
      // compose/sync paths normalizes endings, not this helper.
      const own = 'KEY=value\n\n\n';
      expect(composeFragmentedContent([], own, 'env')).toBe(own);
    });

    it('ignores the language entirely when fragments is empty', () => {
      const own = '{"a": 1}';
      expect(composeFragmentedContent([], own, 'json')).toBe(own);
      expect(composeFragmentedContent([], own, null)).toBe(own);
      expect(composeFragmentedContent([], own, undefined)).toBe(own);
    });
  });

  describe('single fragment with `#`-comment language', () => {
    it('prepends the fragment header, fragment content, blank line, then own header and own content', () => {
      const out = composeFragmentedContent(
        [{ name: 'shared-env', content: 'SHARED=1' }],
        'OWN=2',
        'env'
      );
      // Expected layout:
      //   # === fragment: shared-env ===\nSHARED=1
      //   <blank line>
      //   # === service-specific ===\nOWN=2
      expect(out).toBe(
        '# === fragment: shared-env ===\nSHARED=1\n\n# === service-specific ===\nOWN=2'
      );
    });

    it('emits the fragment header even when the fragment content is empty', () => {
      const out = composeFragmentedContent(
        [{ name: 'empty', content: '' }],
        'OWN=1',
        'env'
      );
      // Empty content still gets its header — operators see the inclusion
      // explicitly rather than wondering where a "phantom" section came from.
      expect(out).toBe(
        '# === fragment: empty ===\n\n\n# === service-specific ===\nOWN=1'
      );
    });
  });

  describe('multiple fragments preserve caller order (no sorting)', () => {
    it('emits fragments in the exact order the caller provided', () => {
      // The caller is expected to have pre-sorted by `position` — this helper
      // does NOT re-sort. Pass them in reverse to prove no sorting happens.
      const out = composeFragmentedContent(
        [
          { name: 'z-last', content: 'Z=1' },
          { name: 'a-first', content: 'A=1' },
        ],
        'OWN=1',
        'env'
      );
      // 'z-last' must appear before 'a-first' because that's the order the
      // caller supplied; if the helper sorted, 'a-first' would come first.
      const zIdx = out.indexOf('z-last');
      const aIdx = out.indexOf('a-first');
      expect(zIdx).toBeGreaterThan(-1);
      expect(aIdx).toBeGreaterThan(-1);
      expect(zIdx).toBeLessThan(aIdx);
    });

    it('separates every section with a single blank line', () => {
      const out = composeFragmentedContent(
        [
          { name: 'a', content: 'A=1' },
          { name: 'b', content: 'B=1' },
        ],
        'OWN=1',
        'env'
      );
      expect(out).toBe(
        '# === fragment: a ===\nA=1\n\n# === fragment: b ===\nB=1\n\n# === service-specific ===\nOWN=1'
      );
    });
  });

  describe('non-`#`-comment languages skip headers', () => {
    it('concatenates JSON fragments + own content without any header markers', () => {
      // JSON has no comment syntax, so injecting `# ===` markers would break
      // any JSON parser. The helper emits raw concatenation instead.
      const out = composeFragmentedContent(
        [{ name: 'shared', content: '{"shared": true}' }],
        '{"own": true}',
        'json'
      );
      expect(out).not.toContain('#');
      expect(out).not.toContain('fragment:');
      expect(out).toBe('{"shared": true}\n\n{"own": true}');
    });

    it('does not inject headers for xml or html either', () => {
      const xmlOut = composeFragmentedContent(
        [{ name: 's', content: '<a/>' }],
        '<b/>',
        'xml'
      );
      const htmlOut = composeFragmentedContent(
        [{ name: 's', content: '<p>x</p>' }],
        '<p>y</p>',
        'html'
      );
      expect(xmlOut).toBe('<a/>\n\n<b/>');
      expect(htmlOut).toBe('<p>x</p>\n\n<p>y</p>');
    });

    it('matches non-hash languages case-insensitively', () => {
      // languageSupportsHashHeaders lower-cases the input before comparison.
      const out = composeFragmentedContent(
        [{ name: 's', content: '{"a": 1}' }],
        '{"b": 2}',
        'JSON'
      );
      expect(out).not.toContain('#');
    });
  });

  describe('unknown / falsy language defaults to header injection', () => {
    it('injects headers for an unknown language string', () => {
      // The deny-list is conservative (json/xml/html). Everything else gets
      // headers — most config formats accept `#` as a comment and a stray `#`
      // is at worst harmless.
      const out = composeFragmentedContent(
        [{ name: 's', content: 'X=1' }],
        'Y=2',
        'totally-made-up-lang'
      );
      expect(out).toContain('# === fragment: s ===');
      expect(out).toContain('# === service-specific ===');
    });

    it('injects headers when language is null', () => {
      const out = composeFragmentedContent(
        [{ name: 's', content: 'X=1' }],
        'Y=2',
        null
      );
      expect(out).toContain('# === fragment: s ===');
    });

    it('injects headers when language is undefined', () => {
      const out = composeFragmentedContent(
        [{ name: 's', content: 'X=1' }],
        'Y=2',
        undefined
      );
      expect(out).toContain('# === fragment: s ===');
    });
  });

  describe('empty own content with fragments present', () => {
    it('still emits the service-specific header followed by the empty body', () => {
      // The own-section header is unconditional once there's at least one
      // fragment — operators reading the rendered file should see the
      // "service-specific" boundary even when the file has no custom content
      // yet. The empty body simply produces a trailing blank line.
      const out = composeFragmentedContent(
        [{ name: 'shared', content: 'SHARED=1' }],
        '',
        'env'
      );
      expect(out).toBe(
        '# === fragment: shared ===\nSHARED=1\n\n# === service-specific ===\n'
      );
    });
  });

  describe('fragment names appear in headers verbatim', () => {
    it('emits names with spaces, dashes and dots as-is', () => {
      const out = composeFragmentedContent(
        [
          { name: 'has spaces and-dashes.and.dots', content: 'X=1' },
        ],
        'Y=2',
        'env'
      );
      expect(out).toContain('# === fragment: has spaces and-dashes.and.dots ===\n');
    });
  });
});

describe('languageSupportsHashHeaders', () => {
  // Smoke-test the predicate. The composer behavior tests above are the real
  // contract, but the predicate is exported and worth covering directly.
  it('returns true for null/undefined/unknown', () => {
    expect(languageSupportsHashHeaders(null)).toBe(true);
    expect(languageSupportsHashHeaders(undefined)).toBe(true);
    expect(languageSupportsHashHeaders('mystery-lang')).toBe(true);
  });

  it('returns true for common `#`-comment languages', () => {
    for (const lang of ['env', 'yaml', 'toml', 'ini', 'sh', 'dockerfile', 'conf']) {
      expect(languageSupportsHashHeaders(lang)).toBe(true);
    }
  });

  it('returns false for json/xml/html (case-insensitive)', () => {
    for (const lang of ['json', 'xml', 'html', 'JSON', 'Html']) {
      expect(languageSupportsHashHeaders(lang)).toBe(false);
    }
  });
});
