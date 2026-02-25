import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    webhookConfig: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc', nonce: 'n' }),
  decrypt: vi.fn().mockReturnValue('my-secret'),
}));

vi.mock('./system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    webhookMaxRetries: 3,
    webhookTimeoutMs: 30000,
    webhookRetryDelaysMs: '[1000,5000,15000]',
  }),
  parseWebhookRetryDelays: vi.fn().mockReturnValue([1000, 5000, 15000]),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { prisma } from '../lib/db.js';
import { dispatchWebhook, testWebhook } from './outgoing-webhooks.js';

const mockPrisma = vi.mocked(prisma);

describe('outgoing-webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('dispatchWebhook', () => {
    it('sends to all matching enabled webhook configs', async () => {
      mockPrisma.webhookConfig.findMany.mockResolvedValue([
        {
          id: 'wh-1',
          name: 'Test Webhook',
          url: 'https://webhook1.example.com',
          encryptedSecret: null,
          secretNonce: null,
          headers: null,
          enabled: true,
          typeFilter: null,
          environmentIds: null,
          lastTriggeredAt: null,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as any);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('OK'),
      });
      mockPrisma.webhookConfig.update.mockResolvedValue({} as any);

      const results = await dispatchWebhook('deployment.success', 'env-1', {
        service: 'web-app',
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('filters by type filter', async () => {
      mockPrisma.webhookConfig.findMany.mockResolvedValue([
        {
          id: 'wh-1',
          name: 'Filtered Webhook',
          url: 'https://webhook1.example.com',
          encryptedSecret: null,
          secretNonce: null,
          headers: null,
          enabled: true,
          typeFilter: JSON.stringify(['deployment.failed']),
          environmentIds: null,
        },
      ] as any);

      const results = await dispatchWebhook('deployment.success', 'env-1', {});

      // Should skip since type doesn't match filter
      expect(mockFetch).not.toHaveBeenCalled();
      expect(results).toHaveLength(0);
    });

    it('includes HMAC signature when secret is configured', async () => {
      mockPrisma.webhookConfig.findMany.mockResolvedValue([
        {
          id: 'wh-1',
          name: 'Signed Webhook',
          url: 'https://webhook1.example.com',
          encryptedSecret: 'encrypted',
          secretNonce: 'nonce',
          headers: null,
          enabled: true,
          typeFilter: null,
          environmentIds: null,
        },
      ] as any);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('OK'),
      });
      mockPrisma.webhookConfig.update.mockResolvedValue({} as any);

      await dispatchWebhook('test', 'env-1', {});

      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers;
      expect(headers).toHaveProperty('X-Webhook-Signature');
    });

    it('retries on failure', async () => {
      mockPrisma.webhookConfig.findMany.mockResolvedValue([
        {
          id: 'wh-1',
          name: 'Retry Webhook',
          url: 'https://webhook1.example.com',
          encryptedSecret: null,
          secretNonce: null,
          headers: null,
          enabled: true,
          typeFilter: null,
          environmentIds: null,
        },
      ] as any);

      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: vi.fn().mockResolvedValue('OK'),
        });
      mockPrisma.webhookConfig.update.mockResolvedValue({} as any);

      const results = await dispatchWebhook('test', 'env-1', {});

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results[0].success).toBe(true);
    });
  });

  describe('testWebhook', () => {
    it('sends test payload to webhook', async () => {
      mockPrisma.webhookConfig.findUnique.mockResolvedValue({
        id: 'wh-1',
        name: 'Test',
        url: 'https://webhook1.example.com',
        encryptedSecret: null,
        secretNonce: null,
        headers: null,
        enabled: true,
      } as any);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('OK'),
      });

      const result = await testWebhook('wh-1');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('returns error for non-existent webhook', async () => {
      mockPrisma.webhookConfig.findUnique.mockResolvedValue(null);

      const result = await testWebhook('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Webhook not found');
    });
  });
});
