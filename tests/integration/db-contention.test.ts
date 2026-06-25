/**
 * Issue #299 — transient 500s under SQLite write-lock contention.
 *
 * End-to-end proof that the DB-retry extension (src/lib/db-retry.ts) is wired
 * into the production singleton client and that genuine write-lock contention
 * no longer surfaces as an opaque 500:
 *
 *   - released within the retry budget  → the write succeeds (2xx)
 *   - contention outlasts the budget    → a retryable 503 (never a 500)
 *   - reads are unaffected (WAL)         → GET still 200 under a held write lock
 *
 * A SECOND raw better-sqlite3 connection holds the write lock, standing in for
 * the real second writer in the reporter's environment (a long external
 * transaction, a checkpoint, or a harness resetting DB state between runs).
 * busy_timeout is shortened for the duration so attempts fail fast instead of
 * freezing the synchronous connection for the 5s production default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { createTestUser } from '../factories/user.js';
import { createTestEnvironment } from '../factories/environment.js';
import { generateTestToken } from '../helpers/auth.js';
import { prisma } from '../../src/lib/db.js';

const dbPath = resolve((process.env.DATABASE_URL || 'file:./test.db').replace(/^file:/, ''));

describe('SQLite write-lock contention (issue #299)', () => {
  let app: TestApp;
  let token: string;
  let envId: string;
  let holder: Database.Database;
  let holdCounter = 0;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@contention.test', role: 'admin' });
    token = await generateTestToken({ id: admin.id, email: admin.email });
    envId = (await createTestEnvironment(app.prisma, { name: 'contention-env' })).id;

    // Production runs WAL; ensure the test DB matches so readers don't block on
    // the held write lock. Converting the file via any connection is enough.
    holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    // Short busy_timeout on the singleton so contended attempts fail fast.
    // Restored in afterAll so the shared DB keeps parity for other suites.
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 80');
  });

  afterAll(async () => {
    releaseWriteLock();
    holder.close();
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 1000');
    await app.close();
  });

  function grabWriteLock(): void {
    holder.prepare('BEGIN IMMEDIATE').run();
    holder
      .prepare('INSERT INTO Environment (id, name, createdAt, updatedAt) VALUES (?,?,?,?)')
      .run(`hold-${holdCounter++}`, `hold-${holdCounter}`, Date.now(), Date.now());
  }
  function releaseWriteLock(): void {
    try {
      holder.prepare('ROLLBACK').run();
    } catch {
      /* not in a transaction */
    }
  }

  function createServer(name: string) {
    return app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/servers`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { name, hostname: '10.0.0.1' },
    });
  }

  it('recovers with a 2xx (never a 500) when the lock releases within the retry budget', async () => {
    grabWriteLock();
    // Release just after the first contended attempt times out and yields.
    setTimeout(releaseWriteLock, 30);

    const res = await createServer('recovers-srv');

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
  });

  it('returns a retryable 503 (not 500) when contention outlasts the retry budget', async () => {
    grabWriteLock(); // held for the whole request
    try {
      const res = await createServer('blocked-srv');
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      releaseWriteLock();
    }
  });

  it('retries a contended statement INSIDE an interactive $transaction without double-writing', async () => {
    // The extension retries per-statement, including statements inside a
    // $transaction. Prove that a contended write inside a transaction recovers
    // and the transaction commits its rows EXACTLY once (no duplication).
    const nameA = `itx-a-${holdCounter}`;
    const nameB = `itx-b-${holdCounter}`;
    grabWriteLock();
    setTimeout(releaseWriteLock, 30);

    await prisma.$transaction(async (tx) => {
      await tx.environment.create({ data: { name: nameA } });
      await tx.environment.create({ data: { name: nameB } });
    });

    const a = await prisma.environment.count({ where: { name: nameA } });
    const b = await prisma.environment.count({ where: { name: nameB } });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('reads (GET) are unaffected by a held write lock in WAL mode', async () => {
    grabWriteLock();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      releaseWriteLock();
    }
  });
});
