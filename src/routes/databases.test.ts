import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestDatabase } from '../../test/factories/database.js';
import { generateTestToken } from '../../test/helpers/auth.js';

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
});
