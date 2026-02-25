/**
 * Audit Verification Tests
 *
 * Tests that sensitive operations always produce audit log entries.
 * Verifies that the audit trail is comprehensive and cannot be bypassed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser } from '../factories/user.js';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService } from '../factories/service.js';

let app: TestApp;
let adminToken: string;
let adminId: string;
let envId: string;
let serverId: string;

beforeAll(async () => {
  app = await buildTestApp();

  const admin = await createTestUser(app.prisma, { role: 'admin', email: 'admin@audit-verify.test' });
  adminId = admin.id;
  adminToken = await generateTestToken({ id: adminId, email: admin.email });

  const env = await createTestEnvironment(app.prisma, { name: 'audit-verify-env' });
  envId = env.id;

  const server = await createTestServer(app.prisma, { environmentId: envId, name: 'audit-verify-server' });
  serverId = server.id;

  // Create configuration settings for secret reveal
  await app.prisma.configurationSettings.create({
    data: { environmentId: envId, allowSecretReveal: true },
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Clear audit logs before each test to isolate audit entries
  await app.prisma.auditLog.deleteMany({});
});

describe('audit verification', () => {
  describe('user management audit', () => {
    it('should audit user creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'audited-user@audit-verify.test',
          password: 'Password123!',
          role: 'viewer',
        },
      });

      expect(res.statusCode).toBe(200);

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'user', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log!.userId).toBe(adminId);
      expect(log!.resourceName).toContain('audited-user@audit-verify.test');
    });

    it('should audit user role update', async () => {
      const target = await createTestUser(app.prisma, { email: 'role-target@audit-verify.test', role: 'viewer' });

      await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'operator' },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'user', action: 'update', resourceId: target.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });

    it('should audit user deletion', async () => {
      const target = await createTestUser(app.prisma, { email: 'delete-target@audit-verify.test', role: 'viewer' });

      await app.inject({
        method: 'DELETE',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'user', action: 'delete', resourceId: target.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('secret management audit', () => {
    it('should audit secret creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'AUDIT_SECRET', value: 'secret-val' },
      });

      expect(res.statusCode).toBe(200);

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'secret', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log!.userId).toBe(adminId);
    });

    it('should audit secret reveal', async () => {
      // Create a secret first
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'REVEAL_AUDIT', value: 'reveal-me' },
      });
      const secretId = createRes.json().secret.id;

      // Clear logs after creation
      await app.prisma.auditLog.deleteMany({});

      // Reveal the secret
      await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'secret', action: 'access', resourceId: secretId },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log!.success).toBe(true);
    });

    it('should audit blocked secret reveal (neverReveal)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'WRITE_ONLY_AUDIT', value: 'no-reveal', neverReveal: true },
      });
      const secretId = createRes.json().secret.id;

      await app.prisma.auditLog.deleteMany({});

      await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'secret', action: 'access', resourceId: secretId, success: false },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log!.success).toBe(false);
    });

    it('should audit secret deletion', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DELETE_AUDIT', value: 'delete-me' },
      });
      const secretId = createRes.json().secret.id;

      await app.prisma.auditLog.deleteMany({});

      await app.inject({
        method: 'DELETE',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'secret', action: 'delete', resourceId: secretId },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('environment management audit', () => {
    it('should audit environment creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'audited-env' },
      });

      expect(res.statusCode).toBe(200);

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'environment', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log!.resourceName).toBe('audited-env');
    });

    it('should audit environment deletion', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'delete-audit-env' });

      await app.prisma.auditLog.deleteMany({});

      await app.inject({
        method: 'DELETE',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'environment', action: 'delete', resourceId: env.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('system settings audit', () => {
    it('should audit system settings update', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/system-settings',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshConnectTimeoutMs: 15000 },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'system_settings', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('admin configuration audit', () => {
    it('should audit SMTP config update', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/admin/smtp',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          host: 'smtp.audit-test.com',
          port: 587,
          fromAddress: 'audit@test.com',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'smtp_config', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });

    it('should audit webhook creation', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Audit Test Webhook',
          url: 'https://example.com/audit-webhook',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'webhook_config', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });

    it('should audit Slack channel creation', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Audit Channel',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/audit-test',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'slack_channel', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('audit log integrity', () => {
    it('should include userId for all audited operations', async () => {
      // Perform several actions
      await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'INTEGRITY_CHECK', value: 'check' },
      });

      const logs = await app.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      for (const log of logs) {
        // Every audit log should have a userId
        expect(log.userId).toBeTruthy();
        expect(log.userId).toBe(adminId);
      }
    });

    it('should include timestamp for all audit entries', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'TIMESTAMP_CHECK', value: 'ts' },
      });

      const logs = await app.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      for (const log of logs) {
        expect(log.createdAt).toBeInstanceOf(Date);
        // Timestamp should be recent (within last 60 seconds)
        const age = Date.now() - log.createdAt.getTime();
        expect(age).toBeLessThan(60_000);
      }
    });
  });
});
