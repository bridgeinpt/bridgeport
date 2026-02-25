import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('user routes', () => {
  let app: TestApp;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    adminUser = await createTestUser(app.prisma, {
      email: 'admin@users.test',
      role: 'admin',
    });
    adminToken = await generateTestToken({ id: adminUser.id, email: adminUser.email });
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/users ====================

  describe('GET /api/users', () => {
    it('should list users for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: 'admin@users.test' }),
        ])
      );
    });

    it('should reject viewer with 403', async () => {
      const viewer = await createTestUser(app.prisma, {
        email: 'viewer-list@users.test',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: viewer.id, email: viewer.email });

      const res = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject operator with 403', async () => {
      const operator = await createTestUser(app.prisma, {
        email: 'op-list@users.test',
        role: 'operator',
      });
      const token = await generateTestToken({ id: operator.id, email: operator.email });

      const res = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== POST /api/users ====================

  describe('POST /api/users', () => {
    it('should create user as admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'newuser@users.test',
          password: 'password-123',
          name: 'New User',
          role: 'operator',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        email: 'newuser@users.test',
        role: 'operator',
      });
    });

    it('should reject duplicate email with 409', async () => {
      await createTestUser(app.prisma, { email: 'dup@users.test' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'dup@users.test',
          password: 'password-123',
        },
      });

      expect(res.statusCode).toBe(409);
    });

    it('should reject invalid email with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'not-valid',
          password: 'password-123',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer creating users with 403', async () => {
      const viewer = await createTestUser(app.prisma, {
        email: 'viewer-create@users.test',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: viewer.id, email: viewer.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'attempt@users.test',
          password: 'password-123',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should create audit log entry', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'audited@users.test',
          password: 'password-123',
          role: 'viewer',
        },
      });

      const userId = res.json().user.id;
      const audit = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'user', resourceId: userId, action: 'create' },
      });

      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(adminUser.id);
    });
  });

  // ==================== PATCH /api/users/:id ====================

  describe('PATCH /api/users/:id', () => {
    it('should allow admin to update role', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'patchrole@users.test',
        role: 'viewer',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${user.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe('operator');
    });

    it('should allow user to update own name', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'patchname@users.test',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${user.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.name).toBe('Updated Name');
    });

    it('should reject non-admin changing role with 403', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'norole@users.test',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${user.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/users/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== DELETE /api/users/:id ====================

  describe('DELETE /api/users/:id', () => {
    it('should allow admin to delete other user', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'deleteme@users.test',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/users/${user.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should reject deleting self with 400', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/users/${adminUser.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/users/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/users/:id/change-password ====================

  describe('POST /api/users/:id/change-password', () => {
    it('should allow user to change own password with current password', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'chpass@users.test',
        password: 'old-password-123',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${user.id}/change-password`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          currentPassword: 'old-password-123',
          newPassword: 'new-password-123',
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify can login with new password
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'chpass@users.test', password: 'new-password-123' },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it('should reject wrong current password with 401', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'wrongcurrent@users.test',
        password: 'actual-password-123',
        role: 'viewer',
      });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${user.id}/change-password`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          currentPassword: 'wrong-password-123',
          newPassword: 'new-password-123',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should allow admin to change other user password without current password', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'adminchpass@users.test',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${user.id}/change-password`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          newPassword: 'admin-set-password-123',
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
