import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestDatabase } from '../../tests/factories/database.js';
import { createTestServer } from '../../tests/factories/server.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('database routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let operatorToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@db.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@db.test', role: 'viewer' });
    const operator = await createTestUser(app.prisma, { email: 'op@db.test', role: 'operator' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });

    const env = await createTestEnvironment(app.prisma, { name: 'db-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/environments/:envId/databases ====================

  describe('GET /api/environments/:envId/databases', () => {
    it('should list databases for environment', async () => {
      await createTestDatabase(app.prisma, { environmentId: envId, name: 'list-db' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/databases`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().databases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'list-db' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/databases`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/databases/:id ====================

  describe('GET /api/databases/:id', () => {
    it('should return database details', async () => {
      const db = await createTestDatabase(app.prisma, { environmentId: envId, name: 'detail-db' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/databases/${db.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().database).toMatchObject({
        id: db.id,
        name: 'detail-db',
      });
    });

    it('should return 404 for non-existent database', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/databases/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/environments/:envId/databases ====================

  describe('POST /api/environments/:envId/databases', () => {
    it('should create database as operator', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/databases`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          name: 'new-db',
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          databaseName: 'mydb',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().database).toMatchObject({
        name: 'new-db',
        type: 'postgres',
      });
    });

    it('should reject viewer creating database with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/databases`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          name: 'viewer-db',
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          databaseName: 'viewerdb',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== PATCH /api/databases/:id ====================

  describe('PATCH /api/databases/:id', () => {
    it('should update database as operator', async () => {
      const db = await createTestDatabase(app.prisma, { environmentId: envId, name: 'upd-db' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/databases/${db.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'updated-db' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().database.name).toBe('updated-db');
    });
  });

  // ==================== DELETE /api/databases/:id ====================

  describe('DELETE /api/databases/:id', () => {
    it('should delete database as operator', async () => {
      const db = await createTestDatabase(app.prisma, { environmentId: envId, name: 'del-db' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/databases/${db.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent database', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/databases/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== GET /api/environments/:envId/databases/metrics/history ====================
  //
  // Columnar response shape (issue #139). The endpoint groups by database
  // `type`, projecting each group's metrics into:
  //   - `databases[]`         — metadata only (no per-point data)
  //   - `timestamps[]`        — union of sample timestamps in the group
  //   - `series[queryName]`   — number[][]  ([dbIdx][timeIdx]) for scalar
  //                              queries / flattened row fields
  //   - `series[queryName]`   — { rows: unknown[][] } for resultType=rows
  //                              queries (snapshot kept structurally intact)
  // A Fastify response schema is attached so any drift in the returned object
  // shape (missing field, wrong nesting) is silently stripped by
  // fast-json-stringify — these tests guard against that drift.
  describe('GET /api/environments/:envId/databases/metrics/history', () => {
    /**
     * Helper: seed a database with monitoring enabled, attached to a
     * DatabaseType that declares the given monitoring queries. Returns the
     * Database so callers can attach DatabaseMetrics rows to it.
     */
    async function seedMonitoredDatabase(opts: {
      envId: string;
      typeName: string;
      typeDisplayName: string;
      dbName: string;
      queries: Array<{
        name: string;
        displayName: string;
        resultType: 'scalar' | 'row' | 'rows';
        unit?: string;
        chartGroup?: string;
        resultMapping?: Record<string, string>;
      }>;
      serverId?: string;
    }) {
      // Use upsert so multiple test cases can share the same `type` without
      // racing on the unique constraint.
      const dbType = await app.prisma.databaseType.upsert({
        where: { name: opts.typeName },
        update: {
          displayName: opts.typeDisplayName,
          monitoringConfig: JSON.stringify({ queries: opts.queries }),
        },
        create: {
          name: opts.typeName,
          displayName: opts.typeDisplayName,
          source: 'user',
          connectionFields: '[]',
          monitoringConfig: JSON.stringify({ queries: opts.queries }),
        },
      });

      const db = await createTestDatabase(app.prisma, {
        environmentId: opts.envId,
        name: opts.dbName,
        type: opts.typeName,
        monitoringEnabled: true,
        serverId: opts.serverId,
      });

      // createTestDatabase doesn't set databaseTypeId — wire it explicitly so
      // the route can resolve queryMeta from the DatabaseType.
      await app.prisma.database.update({
        where: { id: db.id },
        data: { databaseTypeId: dbType.id },
      });

      return db;
    }

    it('returns columnar shape with queryMeta, databases, timestamps, and series per type group', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'db-metrics-shape' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'db-host' });
      const db = await seedMonitoredDatabase({
        envId: env.id,
        typeName: 'pg-shape',
        typeDisplayName: 'PostgreSQL (shape)',
        dbName: 'shape-db',
        queries: [
          { name: 'connections', displayName: 'Connections', resultType: 'scalar', unit: 'count' },
        ],
        serverId: server.id,
      });

      const t0 = Date.now() - 60_000;
      const t1 = Date.now() - 30_000;
      await app.prisma.databaseMetrics.createMany({
        data: [
          { databaseId: db.id, collectedAt: new Date(t0), metricsJson: JSON.stringify({ connections: 5 }) },
          { databaseId: db.id, collectedAt: new Date(t1), metricsJson: JSON.stringify({ connections: 7 }) },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        types: Array<{
          type: string;
          typeName: string;
          queryMeta: Array<{ name: string; displayName: string; resultType: string }>;
          databases: Array<{ id: string; name: string; serverId: string | null; serverName: string | null }>;
          timestamps: string[];
          series: Record<string, unknown>;
        }>;
      };

      const group = body.types.find((g) => g.type === 'pg-shape');
      expect(group).toBeDefined();
      // queryMeta survives the response schema (fast-json-stringify would drop it
      // if the schema were missing it — regression guard for #139 schema drift).
      expect(group!.queryMeta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'connections', displayName: 'Connections', resultType: 'scalar' }),
        ])
      );
      expect(group!.databases).toEqual([
        expect.objectContaining({ id: db.id, name: 'shape-db', serverId: server.id, serverName: 'db-host' }),
      ]);
      // Metadata is not duplicated into the per-point data anymore.
      expect(group!.databases[0]).not.toHaveProperty('data');
      expect(group!.timestamps).toHaveLength(2);
      // series.connections is number[][] indexed by [dbIdx][timeIdx].
      const connectionsSeries = group!.series.connections as Array<Array<number | null>>;
      expect(connectionsSeries).toHaveLength(1);
      expect(connectionsSeries[0]).toEqual([5, 7]);
    });

    it('keeps scalar series as number[][] of [entityIdx][timeIdx], with null for gaps', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'db-metrics-scalar' });
      const dbA = await seedMonitoredDatabase({
        envId: env.id,
        typeName: 'pg-scalar',
        typeDisplayName: 'PostgreSQL (scalar)',
        dbName: 'scalar-a',
        queries: [
          { name: 'connections', displayName: 'Connections', resultType: 'scalar' },
        ],
      });
      const dbB = await seedMonitoredDatabase({
        envId: env.id,
        typeName: 'pg-scalar',
        typeDisplayName: 'PostgreSQL (scalar)',
        dbName: 'scalar-b',
        queries: [
          { name: 'connections', displayName: 'Connections', resultType: 'scalar' },
        ],
      });

      // dbA samples at both t0 and t1; dbB only at t1 — exercises the sparse
      // alignment behaviour (null in the gap, not 0 or undefined).
      const t0 = new Date(Date.now() - 60_000);
      const t1 = new Date(Date.now() - 30_000);
      await app.prisma.databaseMetrics.createMany({
        data: [
          { databaseId: dbA.id, collectedAt: t0, metricsJson: JSON.stringify({ connections: 11 }) },
          { databaseId: dbA.id, collectedAt: t1, metricsJson: JSON.stringify({ connections: 12 }) },
          { databaseId: dbB.id, collectedAt: t1, metricsJson: JSON.stringify({ connections: 22 }) },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        types: Array<{
          type: string;
          databases: Array<{ id: string }>;
          timestamps: string[];
          series: Record<string, Array<Array<number | null>>>;
        }>;
      };

      const group = body.types.find((g) => g.type === 'pg-scalar')!;
      expect(group.timestamps).toHaveLength(2);
      const idxA = group.databases.findIndex((d) => d.id === dbA.id);
      const idxB = group.databases.findIndex((d) => d.id === dbB.id);
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThanOrEqual(0);

      const connections = group.series.connections;
      expect(connections).toHaveLength(group.databases.length);
      // Each row aligns to the same timestamps[] length.
      for (const row of connections) expect(row).toHaveLength(group.timestamps.length);

      const t0Idx = group.timestamps.indexOf(t0.toISOString());
      const t1Idx = group.timestamps.indexOf(t1.toISOString());
      expect(t0Idx).toBeGreaterThanOrEqual(0);
      expect(t1Idx).toBeGreaterThanOrEqual(0);

      expect(connections[idxA]![t0Idx]).toBe(11);
      expect(connections[idxA]![t1Idx]).toBe(12);
      // dbB has no sample at t0 — must be `null`, not 0 or undefined.
      expect(connections[idxB]![t0Idx]).toBeNull();
      expect(connections[idxB]![t1Idx]).toBe(22);
    });

    it('coerces numeric-string scalars (node-postgres int8/numeric) into the chart series', async () => {
      // node-postgres returns int8/bigint/numeric columns as STRINGS to avoid
      // precision loss (e.g. pg_database_size() → "27917335"). The columnar
      // projection used to do `typeof value === 'number' ? value : null`, which
      // nulled every Postgres scalar and left the charts empty. They must come
      // back as numbers now.
      const env = await createTestEnvironment(app.prisma, { name: 'db-metrics-strnum' });
      const db = await seedMonitoredDatabase({
        envId: env.id,
        typeName: 'pg-strnum',
        typeDisplayName: 'PostgreSQL (strnum)',
        dbName: 'strnum-db',
        queries: [
          { name: 'dbSize', displayName: 'Database Size', resultType: 'scalar', unit: 'bytes' },
          { name: 'deadTupleRatio', displayName: 'Dead Tuple Ratio', resultType: 'scalar', unit: '%' },
        ],
      });

      const t0 = new Date(Date.now() - 60_000);
      const t1 = new Date(Date.now() - 30_000);
      await app.prisma.databaseMetrics.createMany({
        data: [
          // Values stored exactly as the pg driver hands them over: strings.
          { databaseId: db.id, collectedAt: t0, metricsJson: JSON.stringify({ dbSize: '27917335', deadTupleRatio: '3.09' }) },
          { databaseId: db.id, collectedAt: t1, metricsJson: JSON.stringify({ dbSize: '27918000', deadTupleRatio: '0' }) },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        types: Array<{ type: string; timestamps: string[]; series: Record<string, Array<Array<number | null>>> }>;
      };
      const group = body.types.find((g) => g.type === 'pg-strnum')!;
      const t0Idx = group.timestamps.indexOf(t0.toISOString());
      const t1Idx = group.timestamps.indexOf(t1.toISOString());

      // Strings became numbers — and stay numbers (not "27917335" the string).
      expect(group.series.dbSize[0]![t0Idx]).toBe(27917335);
      expect(group.series.dbSize[0]![t1Idx]).toBe(27918000);
      // "0" must coerce to 0, not be treated as falsy/null.
      expect(group.series.deadTupleRatio[0]![t0Idx]).toBe(3.09);
      expect(group.series.deadTupleRatio[0]![t1Idx]).toBe(0);
    });

    it('preserves row-result query as { rows: unknown[][] } with snapshot per (db, time)', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'db-metrics-rows' });
      const db = await seedMonitoredDatabase({
        envId: env.id,
        typeName: 'pg-rows',
        typeDisplayName: 'PostgreSQL (rows)',
        dbName: 'rows-db',
        queries: [
          { name: 'slow_queries', displayName: 'Slow Queries', resultType: 'rows' },
        ],
      });

      const t0 = new Date(Date.now() - 60_000);
      const t1 = new Date(Date.now() - 30_000);
      const snapshot0 = [{ query: 'SELECT 1', duration: 100 }];
      const snapshot1 = [
        { query: 'SELECT 2', duration: 200 },
        { query: 'SELECT 3', duration: 300 },
      ];
      await app.prisma.databaseMetrics.createMany({
        data: [
          { databaseId: db.id, collectedAt: t0, metricsJson: JSON.stringify({ slow_queries: snapshot0 }) },
          { databaseId: db.id, collectedAt: t1, metricsJson: JSON.stringify({ slow_queries: snapshot1 }) },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        types: Array<{
          type: string;
          timestamps: string[];
          databases: Array<{ id: string }>;
          series: Record<string, { rows: unknown[][] } | Array<Array<number | null>>>;
        }>;
      };

      const group = body.types.find((g) => g.type === 'pg-rows')!;
      const slot = group.series.slow_queries as { rows: unknown[][] };
      // rows queries keep the structural { rows } envelope.
      expect(slot).toHaveProperty('rows');
      expect(Array.isArray(slot.rows)).toBe(true);
      expect(slot.rows).toHaveLength(group.databases.length);

      const dbIdx = group.databases.findIndex((d) => d.id === db.id);
      const t0Idx = group.timestamps.indexOf(t0.toISOString());
      const t1Idx = group.timestamps.indexOf(t1.toISOString());

      // The original snapshot (array of objects) is preserved verbatim at the
      // (db, time) slot — no flattening, no per-point envelope.
      expect(slot.rows[dbIdx]![t0Idx]).toEqual(snapshot0);
      expect(slot.rows[dbIdx]![t1Idx]).toEqual(snapshot1);
    });
  });

  // ==================== GET /api/environments/:envId/databases/backup-summary ====================
  //
  // Batched endpoint backing the Dashboard's "Database Backups" card — replaces
  // the per-database N+1 fan-out (listDatabaseBackups + getBackupSchedule).
  // Each row carries the *last completed* backup (in-progress/failed are
  // ignored) plus the schedule's enabled/nextRunAt, and a supportsBackup flag
  // derived from the linked DatabaseType's backupCommand.
  describe('GET /api/environments/:envId/databases/backup-summary', () => {
    it('returns { databases: [] } for an environment with no databases', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'bs-empty' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/backup-summary`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ databases: [] });
    });

    it('returns per-database lastBackup and schedule for a mixed-state env', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'bs-mixed' });

      // Type with backupCommand → supportsBackup: true for any DB linked to it.
      const supportedType = await app.prisma.databaseType.upsert({
        where: { name: 'pg-bs' },
        update: { backupCommand: 'pg_dump' },
        create: {
          name: 'pg-bs',
          displayName: 'PostgreSQL (bs)',
          source: 'user',
          connectionFields: '[]',
          backupCommand: 'pg_dump',
        },
      });

      // DB A: has a completed backup AND a schedule.
      const dbA = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'bs-a' });
      await app.prisma.database.update({
        where: { id: dbA.id },
        data: { databaseTypeId: supportedType.id },
      });
      await app.prisma.databaseBackup.create({
        data: {
          databaseId: dbA.id,
          filename: 'a-backup.sql',
          size: BigInt(1024),
          type: 'manual',
          status: 'completed',
          storageType: 'local',
          storagePath: '/var/backups/a-backup.sql',
          completedAt: new Date('2024-06-01T10:00:00Z'),
        },
      });
      const scheduleNext = new Date('2024-06-02T02:00:00Z');
      await app.prisma.backupSchedule.create({
        data: {
          databaseId: dbA.id,
          cronExpression: '0 2 * * *',
          enabled: true,
          nextRunAt: scheduleNext,
        },
      });

      // DB B: schedule only, no completed backups.
      const dbB = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'bs-b' });
      await app.prisma.database.update({
        where: { id: dbB.id },
        data: { databaseTypeId: supportedType.id },
      });
      await app.prisma.backupSchedule.create({
        data: {
          databaseId: dbB.id,
          cronExpression: '0 3 * * *',
          enabled: false,
          nextRunAt: null,
        },
      });

      // DB C: neither schedule nor backup.
      const dbC = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'bs-c' });
      await app.prisma.database.update({
        where: { id: dbC.id },
        data: { databaseTypeId: supportedType.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/backup-summary`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        databases: Array<{
          databaseId: string;
          name: string;
          supportsBackup: boolean;
          lastBackup: { id: string; completedAt: string | null; status: string } | null;
          schedule: { enabled: boolean; nextRunAt: string | null } | null;
        }>;
      };

      // Ordered by name asc — "bs-a", "bs-b", "bs-c".
      expect(body.databases.map((d) => d.name)).toEqual(['bs-a', 'bs-b', 'bs-c']);

      const rowA = body.databases.find((d) => d.databaseId === dbA.id)!;
      expect(rowA.supportsBackup).toBe(true);
      expect(rowA.lastBackup).not.toBeNull();
      expect(rowA.lastBackup!.status).toBe('completed');
      expect(rowA.lastBackup!.completedAt).toBe('2024-06-01T10:00:00.000Z');
      expect(rowA.schedule).toEqual({
        enabled: true,
        nextRunAt: scheduleNext.toISOString(),
      });

      const rowB = body.databases.find((d) => d.databaseId === dbB.id)!;
      expect(rowB.supportsBackup).toBe(true);
      expect(rowB.lastBackup).toBeNull();
      expect(rowB.schedule).toEqual({ enabled: false, nextRunAt: null });

      const rowC = body.databases.find((d) => d.databaseId === dbC.id)!;
      expect(rowC.supportsBackup).toBe(true);
      expect(rowC.lastBackup).toBeNull();
      expect(rowC.schedule).toBeNull();
    });

    it('reports supportsBackup=false when the database type has no backupCommand', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'bs-unsupported' });

      const noBackupType = await app.prisma.databaseType.upsert({
        where: { name: 'redis-bs' },
        update: { backupCommand: null },
        create: {
          name: 'redis-bs',
          displayName: 'Redis (bs)',
          source: 'user',
          connectionFields: '[]',
          backupCommand: null,
        },
      });

      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'cache',
        type: 'redis',
      });
      await app.prisma.database.update({
        where: { id: db.id },
        data: { databaseTypeId: noBackupType.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/backup-summary`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { databases: Array<{ databaseId: string; supportsBackup: boolean }> };
      expect(body.databases).toHaveLength(1);
      expect(body.databases[0]).toMatchObject({
        databaseId: db.id,
        supportsBackup: false,
      });
    });

    it('ignores in_progress and failed backups when picking lastBackup', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'bs-status-filter' });
      const supportedType = await app.prisma.databaseType.upsert({
        where: { name: 'pg-bs-status' },
        update: { backupCommand: 'pg_dump' },
        create: {
          name: 'pg-bs-status',
          displayName: 'PostgreSQL (status filter)',
          source: 'user',
          connectionFields: '[]',
          backupCommand: 'pg_dump',
        },
      });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'bs-status' });
      await app.prisma.database.update({
        where: { id: db.id },
        data: { databaseTypeId: supportedType.id },
      });

      // Older completed backup — this should be the one returned.
      const completed = await app.prisma.databaseBackup.create({
        data: {
          databaseId: db.id,
          filename: 'old-completed.sql',
          size: BigInt(512),
          type: 'manual',
          status: 'completed',
          storageType: 'local',
          storagePath: '/var/backups/old-completed.sql',
          createdAt: new Date('2024-05-01T00:00:00Z'),
          completedAt: new Date('2024-05-01T00:05:00Z'),
        },
      });

      // Newer in_progress backup — must NOT win, even though it's more recent.
      await app.prisma.databaseBackup.create({
        data: {
          databaseId: db.id,
          filename: 'in-progress.sql',
          size: BigInt(0),
          type: 'manual',
          status: 'in_progress',
          storageType: 'local',
          storagePath: '/var/backups/in-progress.sql',
          createdAt: new Date('2024-06-01T00:00:00Z'),
        },
      });

      // Newer failed backup — must NOT win either.
      await app.prisma.databaseBackup.create({
        data: {
          databaseId: db.id,
          filename: 'failed.sql',
          size: BigInt(0),
          type: 'manual',
          status: 'failed',
          storageType: 'local',
          storagePath: '/var/backups/failed.sql',
          createdAt: new Date('2024-06-15T00:00:00Z'),
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/databases/backup-summary`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        databases: Array<{ databaseId: string; lastBackup: { id: string; status: string } | null }>;
      };
      const row = body.databases.find((d) => d.databaseId === db.id)!;
      expect(row.lastBackup).not.toBeNull();
      expect(row.lastBackup!.id).toBe(completed.id);
      expect(row.lastBackup!.status).toBe('completed');
    });

    it('does not leak databases from other environments', async () => {
      const envA = await createTestEnvironment(app.prisma, { name: 'bs-iso-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'bs-iso-b' });
      await createTestDatabase(app.prisma, { environmentId: envA.id, name: 'iso-a-db' });
      await createTestDatabase(app.prisma, { environmentId: envB.id, name: 'iso-b-db' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envA.id}/databases/backup-summary`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { databases: Array<{ name: string }> };
      expect(body.databases.map((d) => d.name)).toEqual(['iso-a-db']);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/databases/backup-summary`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
