import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../../tests/helpers/app.js';
import { createTestUser } from '../../../tests/factories/user.js';
import { generateTestToken } from '../../../tests/helpers/auth.js';

describe('admin smtp routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@smtp.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@smtp.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/smtp', () => {
    it('should return smtp config for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('config');
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/smtp',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/admin/smtp', () => {
    it('should save smtp config as admin', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          fromAddress: 'noreply@example.com',
          fromName: 'BridgePort',
          enabled: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().config).toMatchObject({
        host: 'smtp.example.com',
        fromAddress: 'noreply@example.com',
      });
    });

    it('should reject invalid input with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          host: '', // empty host
          fromAddress: 'not-an-email',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          host: 'smtp.example.com',
          port: 587,
          fromAddress: 'noreply@example.com',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should create audit log', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          host: 'smtp.audit.com',
          port: 465,
          secure: true,
          fromAddress: 'audit@example.com',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'smtp_config', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('POST /api/admin/smtp/test', () => {
    it('should require admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/smtp/test',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/smtp/test',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
