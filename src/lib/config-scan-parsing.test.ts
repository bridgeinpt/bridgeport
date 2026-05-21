import { describe, it, expect } from 'vitest';
import { extractKeyValues, substituteFullValue } from './config-scan-parsing.js';

describe('extractKeyValues', () => {
  describe('env-style KEY=value', () => {
    it('extracts a simple pair', () => {
      expect(extractKeyValues('FOO=bar')).toEqual([{ key: 'FOO', value: 'bar' }]);
    });

    it('strips surrounding double quotes', () => {
      expect(extractKeyValues('FOO="bar baz"')).toEqual([{ key: 'FOO', value: 'bar baz' }]);
    });

    it('strips surrounding single quotes', () => {
      expect(extractKeyValues("FOO='bar baz'")).toEqual([{ key: 'FOO', value: 'bar baz' }]);
    });

    it('keeps embedded quotes that do not wrap the whole value', () => {
      expect(extractKeyValues('FOO=a"b')).toEqual([{ key: 'FOO', value: 'a"b' }]);
    });

    it('ignores comment and blank lines', () => {
      const content = '# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux';
      expect(extractKeyValues(content)).toEqual([
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
      ]);
    });

    it('skips entries with empty values', () => {
      expect(extractKeyValues('EMPTY=\nFULL=ok')).toEqual([{ key: 'FULL', value: 'ok' }]);
    });
  });

  describe('YAML-style KEY: value', () => {
    it('extracts UPPER_SNAKE_CASE keys', () => {
      expect(extractKeyValues('DATABASE_URL: postgres://localhost')).toEqual([
        { key: 'DATABASE_URL', value: 'postgres://localhost' },
      ]);
    });

    // Image #1 from the bug report — docker-compose attribute keys must not be
    // treated as config variables. `restart: unless-stopped` should never be
    // suggested as a `${RESTART}` extraction.
    it('skips lowercase docker-compose attribute keys (Image #1)', () => {
      const compose = [
        'services:',
        '  api:',
        '    image: myapp:latest',
        '    restart: unless-stopped',
        '    command: npm start',
        '    environment:',
        '      DATABASE_URL: postgres://db',
      ].join('\n');
      const pairs = extractKeyValues(compose);
      expect(pairs).toEqual([{ key: 'DATABASE_URL', value: 'postgres://db' }]);
    });

    it('skips kebab-case and camelCase YAML keys', () => {
      const yaml = 'replica-count: 3\nreplicaCount: 3\nREPLICA_COUNT: 3';
      expect(extractKeyValues(yaml)).toEqual([{ key: 'REPLICA_COUNT', value: '3' }]);
    });
  });
});

describe('substituteFullValue', () => {
  // Image #2 from the bug report — the same literal appears as the full RHS
  // of one key AND inside the value of another. The naive `content.split(value)`
  // approach rewrote both; the structured substitution must touch only the
  // full-RHS occurrence.
  it('does not rewrite substrings inside other values (Image #2)', () => {
    const content = [
      'ENVIRONMENT=staging',
      'DJANGO_ALLOWED_HOSTS=app-staging.bridgein.com,localhost',
    ].join('\n');
    const { newContent, replacements } = substituteFullValue(content, 'staging', '${ENVIRONMENT}');
    expect(replacements).toBe(1);
    expect(newContent).toBe(
      [
        'ENVIRONMENT=${ENVIRONMENT}',
        'DJANGO_ALLOWED_HOSTS=app-staging.bridgein.com,localhost',
      ].join('\n')
    );
  });

  it('replaces value across multiple env lines that match exactly', () => {
    const content = ['DB_HOST=10.0.0.1', 'CACHE_HOST=10.0.0.1', 'NOTE=server 10.0.0.1 lives here'].join('\n');
    const { newContent, replacements } = substituteFullValue(content, '10.0.0.1', '${SHARED_HOST}');
    expect(replacements).toBe(2);
    expect(newContent).toBe(
      ['DB_HOST=${SHARED_HOST}', 'CACHE_HOST=${SHARED_HOST}', 'NOTE=server 10.0.0.1 lives here'].join('\n')
    );
  });

  it('preserves surrounding double quotes', () => {
    const { newContent, replacements } = substituteFullValue('TOKEN="abc123"', 'abc123', '${TOKEN}');
    expect(replacements).toBe(1);
    expect(newContent).toBe('TOKEN="${TOKEN}"');
  });

  it('preserves surrounding single quotes', () => {
    const { newContent, replacements } = substituteFullValue("TOKEN='abc123'", 'abc123', '${TOKEN}');
    expect(replacements).toBe(1);
    expect(newContent).toBe("TOKEN='${TOKEN}'");
  });

  it('preserves leading whitespace on the line', () => {
    const { newContent } = substituteFullValue('  FOO=bar', 'bar', '${FOO}');
    expect(newContent).toBe('  FOO=${FOO}');
  });

  it('rewrites a UPPER_SNAKE_CASE YAML pair', () => {
    const { newContent, replacements } = substituteFullValue(
      'DATABASE_URL: postgres://localhost',
      'postgres://localhost',
      '${DATABASE_URL}'
    );
    expect(replacements).toBe(1);
    expect(newContent).toBe('DATABASE_URL: ${DATABASE_URL}');
  });

  it('does not touch lowercase YAML attribute keys', () => {
    // Matches the Image #1 scenario at the substitution layer: even if the
    // scanner somehow proposed `RESTART`, `restart: unless-stopped` must not
    // be rewritten because the YAML key isn't UPPER_SNAKE_CASE.
    const { newContent, replacements } = substituteFullValue(
      '    restart: unless-stopped',
      'unless-stopped',
      '${RESTART}'
    );
    expect(replacements).toBe(0);
    expect(newContent).toBe('    restart: unless-stopped');
  });

  it('returns 0 replacements when no full-RHS match exists', () => {
    const content = 'URL=https://staging-app.example.com/path';
    const { newContent, replacements } = substituteFullValue(content, 'staging', '${ENVIRONMENT}');
    expect(replacements).toBe(0);
    expect(newContent).toBe(content);
  });

  it('leaves comment lines untouched even when value appears in them', () => {
    const content = '# DB_HOST=10.0.0.1 (old)\nDB_HOST=10.0.0.2';
    const { newContent, replacements } = substituteFullValue(content, '10.0.0.1', '${DB_HOST}');
    expect(replacements).toBe(0);
    expect(newContent).toBe(content);
  });
});
