import { describe, it, expect, vi, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { config } from './config.js';
import { isTransientDbError, withDbRetry } from './db-retry.js';

function knownErr(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });
}

describe('isTransientDbError', () => {
  it('flags transient/retryable Prisma codes', () => {
    for (const code of ['P1008', 'P1017', 'P2024', 'P2034']) {
      expect(isTransientDbError(knownErr(code))).toBe(true);
    }
  });

  it('does NOT flag deterministic client/data Prisma errors', () => {
    for (const code of ['P2002', 'P2025', 'P2003', 'P2000']) {
      expect(isTransientDbError(knownErr(code))).toBe(false);
    }
  });

  it('flags SQLite busy/locked messages from raw/unknown errors', () => {
    expect(isTransientDbError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isTransientDbError(new Error('database table is locked'))).toBe(true);
    expect(isTransientDbError(new Error('database schema is locked'))).toBe(true);
    expect(isTransientDbError('SocketTimeout while contacting the database')).toBe(true);
  });

  it('ignores unrelated errors and non-error values', () => {
    expect(isTransientDbError(new Error('validation failed'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError('a plain string')).toBe(false);
    expect(isTransientDbError({ code: 'P1008' })).toBe(false); // not a Prisma error instance
  });
});

describe('withDbRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result without retrying on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withDbRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors and resolves once a later attempt succeeds', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(knownErr('P1008'))
      .mockRejectedValueOnce(knownErr('P1008'))
      .mockResolvedValue('recovered');
    const p = withDbRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-transient error immediately, without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(knownErr('P2002'));
    await expect(withDbRetry(fn)).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after DB_RETRY_MAX_ATTEMPTS on persistent contention and rethrows', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(knownErr('P1008'));
    const p = withDbRetry(fn);
    const settled = expect(p).rejects.toMatchObject({ code: 'P1008' });
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(config.DB_RETRY_MAX_ATTEMPTS);
  });
});
