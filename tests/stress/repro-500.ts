/**
 * Reproduction + metric harness for issue #299:
 *   "Instance returns transient 500s on API requests under sustained load"
 *
 * Builds the real app via the shared `buildTestApp()` (the single source of
 * truth for the plugin/route pipeline — same as the integration tests) and
 * drives a concurrent mix of CRUD (create/update/delete servers + container
 * images) interleaved with GET /api/auth/me on every step — the shape the
 * terraform-provider-bridgeport acceptance suite produces. Requests are served
 * through the production singleton client (src/lib/db.ts), which carries the
 * DB-retry extension under test.
 *
 * THE METRIC is the count of `500` responses under load. A single in-process
 * connection can't self-contend, so to reproduce the failure deterministically
 * a background "lock holder" using a SECOND raw better-sqlite3 connection grabs
 * the SQLite write lock in short bursts — standing in for the real second
 * writer in the reporter's environment (a long external transaction, a
 * checkpoint, or a harness resetting DB state between runs). Set
 * REPRO_CONTENTION=0 to disable.
 *
 *   pnpm run test:repro-299
 *
 * Exit code is non-zero iff any 500 was observed (503s are acceptable: they are
 * retryable backpressure, which is the documented contract from this fix).
 *
 * Env vars must be set BEFORE any app module loads (Zod validates at import
 * time), so this file uses dynamic imports throughout.
 */

process.env.MASTER_KEY ??= 'ilyS3JROhJmj8QEYHuoZts8aoK2LG9SHl0EgIn0gsVw=';
process.env.JWT_SECRET ??= 'repro-jwt-secret';
process.env.NODE_ENV ??= 'test';
process.env.SCHEDULER_ENABLED ??= 'false';
process.env.PLUGINS_DIR ??= './plugins';
process.env.UPLOAD_DIR ??= './repro-uploads';
process.env.DATABASE_URL ??= 'file:./repro.db';
process.env.MCP_ENABLED ??= 'false';

import { rmSync } from 'fs';
import { resolve } from 'path';

const WORKERS = Number(process.env.REPRO_WORKERS ?? '8');
const CYCLES = Number(process.env.REPRO_CYCLES ?? '12');
const CONTENTION = process.env.REPRO_CONTENTION !== '0';
// Short busy_timeout keeps the harness fast: a contended write fails quickly
// instead of freezing the (synchronous) connection. Same mechanism, smaller timing.
const BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? '150');

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  const dbPath = resolve((process.env.DATABASE_URL || 'file:./repro.db').replace(/^file:/, ''));
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }

  const { buildTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/lib/db.js');
  const { createUser, createApiToken } = await import('../../src/services/auth.js');
  const Database = (await import('better-sqlite3')).default;

  const app = await buildTestApp();
  // buildTestApp does not run initializeDatabase(); set WAL + a short
  // busy_timeout on the singleton (the connection that serves requests).
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const admin = await createUser('admin@repro.local', 'password1234', 'Admin', 'admin');
  const { token } = await createApiToken({
    name: 'repro-token',
    role: 'admin',
    allEnvironments: true,
    ownerUserId: admin.id,
  });
  const env = await prisma.environment.create({ data: { name: 'repro-env' } });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const stats = { total: 0, ok: 0, c500: 0, c503: 0, other: new Map<number, number>() };
  const sample500: { method: string; url: string; body: string }[] = [];

  function record(method: string, url: string, res: { statusCode: number; body: string }) {
    stats.total++;
    if (res.statusCode >= 200 && res.statusCode < 300) stats.ok++;
    else if (res.statusCode === 500) {
      stats.c500++;
      if (sample500.length < 6) sample500.push({ method, url, body: res.body.slice(0, 200) });
    } else if (res.statusCode === 503) stats.c503++;
    else stats.other.set(res.statusCode, (stats.other.get(res.statusCode) ?? 0) + 1);
  }

  async function authMe() {
    record('GET', '/api/auth/me', await app.inject({ method: 'GET', url: '/api/auth/me', headers }));
  }

  async function crudCycle(w: number, i: number) {
    const cr = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/servers`,
      headers,
      payload: JSON.stringify({ name: `srv-${w}-${i}`, hostname: `10.${w}.0.${i % 250}` }),
    });
    record('POST', '/servers', cr);
    await authMe();
    const serverId = (() => {
      try {
        return cr.json()?.server?.id ?? cr.json()?.id;
      } catch {
        return undefined;
      }
    })();

    const ci = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/container-images`,
      headers,
      payload: JSON.stringify({ name: `img-${w}-${i}`, imageName: `repo/img-${w}-${i}`, tagFilter: 'latest' }),
    });
    record('POST', '/container-images', ci);
    await authMe();
    const imageId = (() => {
      try {
        return ci.json()?.id ?? ci.json()?.containerImage?.id;
      } catch {
        return undefined;
      }
    })();

    if (serverId) {
      record(
        'PATCH',
        '/servers/:id',
        await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers,
          payload: JSON.stringify({ hostname: `10.${w}.1.${i % 250}` }),
        })
      );
      await authMe();
    }
    if (imageId) {
      record('DELETE', '/container-images/:id', await app.inject({ method: 'DELETE', url: `/api/container-images/${imageId}`, headers }));
      await authMe();
    }
    if (serverId) {
      record('DELETE', '/servers/:id', await app.inject({ method: 'DELETE', url: `/api/servers/${serverId}`, headers }));
      await authMe();
    }
  }

  // Background lock-holder: a SECOND raw connection that grabs the write lock in
  // bursts. Stands in for any concurrent second writer in the reporter's env.
  let stopContention = false;
  let holdBursts = 0;
  async function contentionLoop() {
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    try {
      while (!stopContention) {
        try {
          holder.prepare('BEGIN IMMEDIATE').run();
          holder
            .prepare('INSERT INTO Environment (id, name, createdAt, updatedAt) VALUES (?,?,?,?)')
            .run(`hold-${holdBursts}`, `hold-${holdBursts}`, Date.now(), Date.now());
          holdBursts++;
          await delay(BUSY_TIMEOUT_MS + 60); // hold past busy_timeout, then release
        } finally {
          try {
            holder.prepare('ROLLBACK').run();
          } catch {
            /* not in a txn */
          }
        }
        await delay(120); // gap so most writes get through uncontended
      }
    } finally {
      holder.close();
    }
  }

  const t0 = Date.now();
  const contender = CONTENTION ? contentionLoop() : Promise.resolve();
  await Promise.all(
    Array.from({ length: WORKERS }, (_, w) =>
      (async () => {
        for (let i = 0; i < CYCLES; i++) await crudCycle(w, i);
      })()
    )
  );
  stopContention = true;
  await contender;
  const elapsed = Date.now() - t0;

  await app.close();

  console.log('\n========== REPRO #299 METRIC ==========');
  console.log(`contention=${CONTENTION ? 'on' : 'off'} workers=${WORKERS} cycles=${CYCLES} busy_timeout=${BUSY_TIMEOUT_MS}ms lock-bursts=${holdBursts} elapsed=${elapsed}ms`);
  console.log(`total requests  : ${stats.total}`);
  console.log(`2xx             : ${stats.ok}`);
  console.log(`500 (BUG)       : ${stats.c500}`);
  console.log(`503 (retryable) : ${stats.c503}`);
  console.log(`other           : ${[...stats.other.entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`);
  if (sample500.length) {
    console.log('\n--- sample 500 wire bodies (should be empty after the fix) ---');
    for (const s of sample500) console.log(`${s.method} ${s.url} => ${s.body}`);
  }
  console.log('========================================\n');

  return stats.c500 > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('repro harness crashed:', err);
    process.exit(2);
  });
