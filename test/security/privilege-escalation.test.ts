import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { createTestUser } from '../factories/user.js';
import { generateTestToken } from '../helpers/auth.js';

describe('privilege escalation', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let adminId: string;
  let operatorId: string;
  let viewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();

    const admin = await createTestUser(app.prisma, { email: 'admin@privesc.test', role: 'admin' });
    const operator = await createTestUser(app.prisma, { email: 'operator@privesc.test', role: 'operator' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@privesc.test', role: 'viewer' });

    adminId = admin.id;
    operatorId = operator.id;
    viewerId = viewer.id;

    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('role self-escalation', () => {
    it('viewer cannot change own role to admin', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(403);

      // Verify role was not changed in the database
      const user = await app.prisma.user.findUnique({ where: { id: viewerId } });
      expect(user!.role).toBe('viewer');
    });

    it('viewer cannot change own role to operator', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(403);

      const user = await app.prisma.user.findUnique({ where: { id: viewerId } });
      expect(user!.role).toBe('viewer');
    });

    it('operator cannot change own role to admin', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${operatorId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(403);

      const user = await app.prisma.user.findUnique({ where: { id: operatorId } });
      expect(user!.role).toBe('operator');
    });
  });

  describe('role escalation of other users', () => {
    it('operator cannot change another user role', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { role: 'admin' },
      });

      // Operator cannot access other user's PATCH (requireAdminOrSelf)
      expect([403]).toContain(res.statusCode);

      const user = await app.prisma.user.findUnique({ where: { id: viewerId } });
      expect(user!.role).toBe('viewer');
    });

    it('admin can change another user role', async () => {
      // First change viewer to operator
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(200);

      // Reset back to viewer
      await app.prisma.user.update({
        where: { id: viewerId },
        data: { role: 'viewer' },
      });
    });
  });

  describe('admin-only operations by lower roles', () => {
    it('viewer cannot create users', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          email: 'newuser@privesc.test',
          password: 'Password123!',
          role: 'admin',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('operator cannot create users', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          email: 'newuser2@privesc.test',
          password: 'Password123!',
          role: 'viewer',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('viewer cannot delete users', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/users/${operatorId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);

      // Verify user still exists
      const user = await app.prisma.user.findUnique({ where: { id: operatorId } });
      expect(user).not.toBeNull();
    });

    it('viewer cannot update system settings', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system-settings',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { sshConnectTimeoutMs: 99999 },
      });

      expect(res.statusCode).toBe(403);
    });

    it('operator cannot update system settings', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system-settings',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { sshConnectTimeoutMs: 99999 },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('user cannot modify other user accounts', () => {
    it('viewer cannot change another viewer name', async () => {
      const otherViewer = await createTestUser(app.prisma, { email: 'other@privesc.test', role: 'viewer' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${otherViewer.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Hacked Name' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('viewer can update own name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'My Real Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.name).toBe('My Real Name');
    });
  });
});
