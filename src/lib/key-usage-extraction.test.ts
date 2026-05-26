import { describe, it, expect, vi } from 'vitest';
import {
  extractReferencedKeys,
  syncSecretUsageForConfigFile,
  syncVarUsageForConfigFile,
  syncUsageForConfigFile,
} from './key-usage-extraction.js';

describe('extractReferencedKeys', () => {
  it('extracts ${KEY} placeholders', () => {
    const keys = extractReferencedKeys('DATABASE_URL=${DATABASE_URL}\nPORT=${PORT}');
    expect(Array.from(keys).sort()).toEqual(['DATABASE_URL', 'PORT']);
  });

  it('extracts bare $KEY placeholders', () => {
    const keys = extractReferencedKeys('echo $DATABASE_URL && cat $REDIS_URL.txt');
    expect(keys.has('DATABASE_URL')).toBe(true);
    expect(keys.has('REDIS_URL')).toBe(true);
  });

  it('extracts {{KEY}} placeholders', () => {
    const keys = extractReferencedKeys('cn = {{COMMON_NAME}}\nemail = {{ADMIN_EMAIL}}');
    expect(Array.from(keys).sort()).toEqual(['ADMIN_EMAIL', 'COMMON_NAME']);
  });

  it('extracts ^KEY= env-file references at start of line', () => {
    const keys = extractReferencedKeys('FOO=bar\nBAZ=qux');
    expect(Array.from(keys).sort()).toEqual(['BAZ', 'FOO']);
  });

  it('extracts ^KEY= references after a newline', () => {
    const keys = extractReferencedKeys('# header\nDATABASE_URL=postgres://x');
    expect(keys.has('DATABASE_URL')).toBe(true);
  });

  it('ignores lowercase variables', () => {
    const keys = extractReferencedKeys('${database_url} $path {{snake_case}}\nfoo=1');
    expect(keys.size).toBe(0);
  });

  it('ignores numbers and special chars in placeholders', () => {
    const keys = extractReferencedKeys('${1} ${_FOO} ${ FOO } $1 {{1}}');
    expect(keys.size).toBe(0);
  });

  it('does not match $KEY when followed by more word characters', () => {
    // $FOOBAR should NOT match the secret named "FOO" — the next char extends the name.
    const keys = extractReferencedKeys('$FOOBAR');
    expect(keys.has('FOO')).toBe(false);
    expect(keys.has('FOOBAR')).toBe(true);
  });

  it('matches $KEY at end of string', () => {
    const keys = extractReferencedKeys('echo $JWT_SECRET');
    expect(keys.has('JWT_SECRET')).toBe(true);
  });

  it('matches $KEY followed by punctuation', () => {
    const keys = extractReferencedKeys('echo $JWT_SECRET.txt $REDIS_URL,foo');
    expect(keys.has('JWT_SECRET')).toBe(true);
    expect(keys.has('REDIS_URL')).toBe(true);
  });

  it('returns an empty set for empty input', () => {
    expect(extractReferencedKeys('').size).toBe(0);
  });

  it('handles mixed patterns', () => {
    const content = [
      'FOO=${FOO}',
      'BAR=$BAR',
      'BAZ={{BAZ}}',
      'QUX=raw-value',
    ].join('\n');
    const keys = extractReferencedKeys(content);
    expect(Array.from(keys).sort()).toEqual(['BAR', 'BAZ', 'FOO', 'QUX']);
  });

  // Regression: SQLite LIKE treats `_` as a single-char wildcard, so a backfill
  // that used `LIKE '%${' || key || '}%'` would have matched `${DBXURL}` for a
  // secret keyed `DB_URL`. The runtime extractor uses a literal regex match,
  // so the underscore is matched literally — and the (rewritten) migration
  // uses GLOB to mirror that semantics. This test pins the extractor's
  // behaviour so any future regex change is caught.
  it('matches the underscore literally (DB_URL is NOT matched by DBXURL)', () => {
    expect(extractReferencedKeys('${DB_URL}').has('DB_URL')).toBe(true);
    expect(extractReferencedKeys('${DBXURL}').has('DB_URL')).toBe(false);
  });
});

describe('syncSecretUsageForConfigFile', () => {
  function makeDb(initial: Array<{ secretKey: string }> = []) {
    const findMany = vi.fn().mockResolvedValue(initial);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    return {
      db: { secretUsage: { findMany, deleteMany, createMany } } as never,
      findMany,
      deleteMany,
      createMany,
    };
  }

  it('creates rows for newly-referenced keys', async () => {
    const { db, createMany, deleteMany } = makeDb([]);
    await syncSecretUsageForConfigFile(db, {
      id: 'cf1',
      environmentId: 'env1',
      content: '${FOO} ${BAR}',
      isBinary: false,
    });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { environmentId: 'env1', secretKey: 'FOO', configFileId: 'cf1' },
        { environmentId: 'env1', secretKey: 'BAR', configFileId: 'cf1' },
      ]),
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows that are no longer referenced', async () => {
    const { db, createMany, deleteMany } = makeDb([
      { secretKey: 'OLD' },
      { secretKey: 'FOO' },
    ]);
    await syncSecretUsageForConfigFile(db, {
      id: 'cf1',
      environmentId: 'env1',
      content: '${FOO}',
      isBinary: false,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { configFileId: 'cf1', secretKey: { in: ['OLD'] } },
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('clears all rows for binary files', async () => {
    const { db, createMany, deleteMany } = makeDb([
      { secretKey: 'OLD' },
    ]);
    await syncSecretUsageForConfigFile(db, {
      id: 'cf1',
      environmentId: 'env1',
      content: '${FOO}', // would normally extract FOO; binary skip ignores it
      isBinary: true,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { configFileId: 'cf1', secretKey: { in: ['OLD'] } },
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('no-ops when existing matches referenced', async () => {
    const { db, createMany, deleteMany } = makeDb([{ secretKey: 'FOO' }]);
    await syncSecretUsageForConfigFile(db, {
      id: 'cf1',
      environmentId: 'env1',
      content: '${FOO}',
      isBinary: false,
    });
    expect(createMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('syncVarUsageForConfigFile', () => {
  it('uses the varUsage delegate and varKey column', async () => {
    const findMany = vi.fn().mockResolvedValue([{ varKey: 'OLD_VAR' }]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { varUsage: { findMany, deleteMany, createMany } } as never;

    await syncVarUsageForConfigFile(db, {
      id: 'cf2',
      environmentId: 'env2',
      content: '${NEW_VAR}',
      isBinary: false,
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { configFileId: 'cf2', varKey: { in: ['OLD_VAR'] } },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [{ environmentId: 'env2', varKey: 'NEW_VAR', configFileId: 'cf2' }],
    });
  });
});

describe('syncUsageForConfigFile', () => {
  it('runs both secret and var syncs', async () => {
    const secretCalls: unknown[] = [];
    const varCalls: unknown[] = [];
    const db = {
      secretUsage: {
        findMany: vi.fn().mockImplementation(async () => {
          secretCalls.push('findMany');
          return [];
        }),
        deleteMany: vi.fn(),
        createMany: vi.fn().mockImplementation(async () => {
          secretCalls.push('createMany');
          return { count: 0 };
        }),
      },
      varUsage: {
        findMany: vi.fn().mockImplementation(async () => {
          varCalls.push('findMany');
          return [];
        }),
        deleteMany: vi.fn(),
        createMany: vi.fn().mockImplementation(async () => {
          varCalls.push('createMany');
          return { count: 0 };
        }),
      },
    } as never;

    await syncUsageForConfigFile(db, {
      id: 'cf3',
      environmentId: 'env3',
      content: '${FOO}',
      isBinary: false,
    });

    expect(secretCalls).toContain('findMany');
    expect(varCalls).toContain('findMany');
  });
});
