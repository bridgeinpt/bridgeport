import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('system-settings routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@sysset.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@sysset.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/settings/system ====================

  describe('GET /api/settings/system', () => {
    it('should return system settings for any authenticated user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('settings');
      expect(res.json()).toHaveProperty('defaults');
    });

    it('should expose retention settings and no longer expose doRegistryToken', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { settings } = res.json();
      expect(settings).toHaveProperty('notificationRetentionDays');
      expect(settings).toHaveProperty('healthLogRetentionDays');
      expect(settings).toHaveProperty('webhookDeliveryRetentionDays');
      expect(settings).toHaveProperty('imageDigestRetentionDays');
      expect(settings).not.toHaveProperty('doRegistryToken');
      expect(settings).not.toHaveProperty('doRegistryTokenSet');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== PUT /api/settings/system ====================

  describe('PUT /api/settings/system', () => {
    it('should update settings as admin', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 30000 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().settings.sshCommandTimeoutMs).toBe(30000);
    });

    it('should reject viewer updating settings with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { sshCommandTimeoutMs: 30000 },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject out-of-range values with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 100 }, // min is 1000
      });

      expect(res.statusCode).toBe(400);
    });

    it('should persist a valid notificationRetentionDays', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { notificationRetentionDays: 45 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().settings.notificationRetentionDays).toBe(45);

      const persisted = await app.prisma.systemSettings.findUnique({
        where: { id: 'singleton' },
      });
      expect(persisted?.notificationRetentionDays).toBe(45);
    });

    it('should reject notificationRetentionDays of 0 with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { notificationRetentionDays: 0 }, // min is 1
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject notificationRetentionDays of 400 with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { notificationRetentionDays: 400 }, // max is 365
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject healthLogRetentionDays and webhookDeliveryRetentionDays out of 1-365', async () => {
      const tooLow = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { healthLogRetentionDays: 0 },
      });
      expect(tooLow.statusCode).toBe(400);

      const tooHigh = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { webhookDeliveryRetentionDays: 366 },
      });
      expect(tooHigh.statusCode).toBe(400);
    });

    it('should accept imageDigestRetentionDays up to 3650 but reject 0 and 3651', async () => {
      const ok = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { imageDigestRetentionDays: 3650 },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().settings.imageDigestRetentionDays).toBe(3650);

      const zero = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { imageDigestRetentionDays: 0 },
      });
      expect(zero.statusCode).toBe(400);

      const tooHigh = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { imageDigestRetentionDays: 3651 },
      });
      expect(tooHigh.statusCode).toBe(400);
    });

    it('reconciles the six tier fields to PRESETS[preset] for a non-custom preset (Fix B)', async () => {
      // First make the stored tiers deliberately NOT match any preset (custom),
      // so we can prove the next non-custom PUT overwrites them server-side.
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          backupRetentionPreset: 'custom',
          backupRetentionKeepLast: 99,
          backupRetentionDaily: 99,
          backupRetentionWeekly: 99,
          backupRetentionMonthly: 99,
          backupRetentionYearly: 49,
          backupRetentionMinFloor: 9,
        },
      });

      // Now select the 'lean' preset. Tiers must be reconciled to PRESETS.lean
      // even though the body carries no tier fields (the UI hides them).
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { backupRetentionPreset: 'lean' },
      });
      expect(res.statusCode).toBe(200);

      // PRESETS.lean = { keepLast: 12, daily: 7, weekly: 4, monthly: 0, yearly: 0, minFloor: 2 }
      const { settings } = res.json();
      expect(settings.backupRetentionPreset).toBe('lean');
      expect(settings.backupRetentionKeepLast).toBe(12);
      expect(settings.backupRetentionDaily).toBe(7);
      expect(settings.backupRetentionWeekly).toBe(4);
      expect(settings.backupRetentionMonthly).toBe(0);
      expect(settings.backupRetentionYearly).toBe(0);
      expect(settings.backupRetentionMinFloor).toBe(2);

      // Persisted, not just echoed.
      const persisted = await app.prisma.systemSettings.findUnique({ where: { id: 'singleton' } });
      expect(persisted?.backupRetentionKeepLast).toBe(12);
      expect(persisted?.backupRetentionMonthly).toBe(0);
      expect(persisted?.backupRetentionPreset).toBe('lean');
    });

    it('leaves submitted tiers untouched for the custom preset (Fix B)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          backupRetentionPreset: 'custom',
          backupRetentionKeepLast: 5,
          backupRetentionDaily: 3,
          backupRetentionWeekly: 1,
          backupRetentionMonthly: 0,
          backupRetentionYearly: 0,
          backupRetentionMinFloor: 2,
        },
      });
      expect(res.statusCode).toBe(200);
      const { settings } = res.json();
      // Custom keeps exactly what was submitted.
      expect(settings.backupRetentionKeepLast).toBe(5);
      expect(settings.backupRetentionDaily).toBe(3);
      expect(settings.backupRetentionWeekly).toBe(1);
    });

    it('does not touch tier fields when no preset is submitted (Fix B)', async () => {
      // Set a known balanced baseline first.
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { backupRetentionPreset: 'balanced' },
      });
      // A PUT that changes an unrelated field must leave the tiers as-is.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 45000 },
      });
      expect(res.statusCode).toBe(200);
      const { settings } = res.json();
      // Still the balanced tiers (keepLast 24, monthly 6) — untouched.
      expect(settings.backupRetentionKeepLast).toBe(24);
      expect(settings.backupRetentionMonthly).toBe(6);
    });

    it('should create audit log entry', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { maxUploadSizeMb: 100 },
      });

      const audit = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'system_settings', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(audit).not.toBeNull();
    });
  });

  // ==================== POST /api/settings/system/reset ====================

  describe('POST /api/settings/system/reset', () => {
    it('should reset settings as admin', async () => {
      // First change a setting
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 5000 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/system/reset',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('message', 'Settings reset to defaults');
    });

    it('should reject viewer resetting settings with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/system/reset',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
