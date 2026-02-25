import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    slackChannel: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    slackTypeRouting: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc-url', nonce: 'nonce-1' }),
  decrypt: vi.fn().mockReturnValue('https://hooks.slack.com/test'),
}));

vi.mock('./system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    webhookTimeoutMs: 30000,
    publicUrl: 'https://bridgeport.example.com',
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { prisma } from '../lib/db.js';
import { encrypt } from '../lib/crypto.js';
import {
  listSlackChannels,
  createSlackChannel,
  updateSlackChannel,
  deleteSlackChannel,
  buildSlackMessage,
  dispatchSlackNotification,
  testSlackChannel,
} from './slack-notifications.js';

const mockPrisma = vi.mocked(prisma);

describe('slack-notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('listSlackChannels', () => {
    it('should return formatted channel list', async () => {
      mockPrisma.slackChannel.findMany.mockResolvedValue([
        {
          id: 'ch-1',
          name: 'alerts',
          slackChannelName: '#alerts',
          webhookUrl: 'enc-url',
          webhookUrlNonce: 'nonce',
          isDefault: true,
          enabled: true,
          lastTestedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as any);

      const result = await listSlackChannels();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('alerts');
      expect(result[0].hasWebhookUrl).toBe(true);
      // Should not expose raw webhook URL
      expect(result[0]).not.toHaveProperty('webhookUrl');
    });
  });

  describe('createSlackChannel', () => {
    it('should encrypt webhook URL and create channel', async () => {
      mockPrisma.slackChannel.create.mockResolvedValue({
        id: 'ch-1',
        name: 'deployments',
        slackChannelName: '#deployments',
        webhookUrl: 'enc-url',
        webhookUrlNonce: 'nonce-1',
        isDefault: false,
        enabled: true,
        lastTestedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await createSlackChannel({
        name: 'deployments',
        slackChannelName: '#deployments',
        webhookUrl: 'https://hooks.slack.com/services/T123/B456/abc',
      });

      expect(encrypt).toHaveBeenCalledWith('https://hooks.slack.com/services/T123/B456/abc');
      expect(result.name).toBe('deployments');
      expect(result.hasWebhookUrl).toBe(true);
    });

    it('should unset other defaults when setting isDefault', async () => {
      mockPrisma.slackChannel.create.mockResolvedValue({
        id: 'ch-1',
        name: 'main',
        slackChannelName: null,
        webhookUrl: 'enc-url',
        webhookUrlNonce: 'nonce-1',
        isDefault: true,
        enabled: true,
        lastTestedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await createSlackChannel({
        name: 'main',
        webhookUrl: 'https://hooks.slack.com/test',
        isDefault: true,
      });

      expect(mockPrisma.slackChannel.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    });
  });

  describe('deleteSlackChannel', () => {
    it('should delete a channel by ID', async () => {
      mockPrisma.slackChannel.delete.mockResolvedValue({} as any);

      await deleteSlackChannel('ch-1');

      expect(mockPrisma.slackChannel.delete).toHaveBeenCalledWith({ where: { id: 'ch-1' } });
    });
  });

  describe('buildSlackMessage', () => {
    const baseNotificationType = {
      id: 'type-1',
      code: 'deployment.success',
      name: 'Deployment Success',
      description: 'Deployment succeeded',
      template: 'Service deployed',
      defaultChannels: '[]',
      severity: 'info',
      category: 'deployments',
      enabled: true,
      bounceEnabled: false,
      bounceThreshold: 3,
      bounceCooldown: 900,
      createdAt: new Date(),
    };

    it('should build message with header block', () => {
      const message = buildSlackMessage({
        title: 'Deployment Complete',
        message: 'Service web-app deployed to production',
        data: {},
        notificationType: baseNotificationType as any,
      });

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0].blocks.length).toBeGreaterThan(0);

      const headerBlock = message.attachments[0].blocks.find(
        (b: any) => b.type === 'header'
      );
      expect(headerBlock).toBeDefined();
      expect(headerBlock!.text!.text).toContain('Deployment Complete');
    });

    it('should include environment field when provided', () => {
      const message = buildSlackMessage({
        title: 'Alert',
        message: 'Server offline',
        data: {},
        environmentName: 'production',
        notificationType: baseNotificationType as any,
      });

      const text = JSON.stringify(message);
      expect(text).toContain('production');
      expect(text).toContain('Environment');
    });

    it('should include service name when in data', () => {
      const message = buildSlackMessage({
        title: 'Deployed',
        message: 'Deployment successful',
        data: { serviceName: 'web-app' },
        notificationType: baseNotificationType as any,
      });

      const text = JSON.stringify(message);
      expect(text).toContain('web-app');
    });

    it('should include server name when in data', () => {
      const message = buildSlackMessage({
        title: 'Server Alert',
        message: 'Server down',
        data: { serverName: 'prod-1' },
        notificationType: { ...baseNotificationType, severity: 'critical' } as any,
      });

      const text = JSON.stringify(message);
      expect(text).toContain('prod-1');
    });

    it('should use correct color for critical severity', () => {
      const message = buildSlackMessage({
        title: 'Critical',
        message: 'System down',
        data: {},
        notificationType: { ...baseNotificationType, severity: 'critical' } as any,
      });

      expect(message.attachments[0].color).toBe('#dc2626');
    });

    it('should use correct color for warning severity', () => {
      const message = buildSlackMessage({
        title: 'Warning',
        message: 'Disk low',
        data: {},
        notificationType: { ...baseNotificationType, severity: 'warning' } as any,
      });

      expect(message.attachments[0].color).toBe('#f59e0b');
    });

    it('should use correct color for info severity', () => {
      const message = buildSlackMessage({
        title: 'Info',
        message: 'Normal event',
        data: {},
        notificationType: baseNotificationType as any,
      });

      expect(message.attachments[0].color).toBe('#22c55e');
    });

    it('should add action buttons when bridgeportUrl provided', () => {
      const message = buildSlackMessage(
        {
          title: 'Deployed',
          message: 'Success',
          data: { serviceId: 'svc-1' },
          notificationType: baseNotificationType as any,
        },
        'https://bridgeport.example.com'
      );

      const actionsBlock = message.attachments[0].blocks.find(
        (b: any) => b.type === 'actions'
      );
      expect(actionsBlock).toBeDefined();
    });

    it('should not add action buttons when no bridgeportUrl', () => {
      const message = buildSlackMessage({
        title: 'Deployed',
        message: 'Success',
        data: {},
        notificationType: baseNotificationType as any,
      });

      const actionsBlock = message.attachments[0].blocks.find(
        (b: any) => b.type === 'actions'
      );
      expect(actionsBlock).toBeUndefined();
    });

    it('should include context block with notification type code', () => {
      const message = buildSlackMessage({
        title: 'Test',
        message: 'Test message',
        data: {},
        notificationType: baseNotificationType as any,
      });

      const contextBlock = message.attachments[0].blocks.find(
        (b: any) => b.type === 'context'
      );
      expect(contextBlock).toBeDefined();
    });
  });

  describe('dispatchSlackNotification', () => {
    const mockNotificationType = {
      id: 'type-1',
      code: 'deployment.success',
      name: 'Deployment Success',
      severity: 'info',
    };

    it('should return empty array when no channels match', async () => {
      mockPrisma.slackTypeRouting.findMany.mockResolvedValue([]);
      mockPrisma.slackChannel.findFirst.mockResolvedValue(null);

      const results = await dispatchSlackNotification(
        mockNotificationType as any,
        'Deploy Complete',
        'Service deployed',
        {},
        'env-1'
      );

      expect(results).toEqual([]);
    });

    it('should use default channel when no routing matches', async () => {
      mockPrisma.slackTypeRouting.findMany.mockResolvedValue([]);
      mockPrisma.slackChannel.findFirst.mockResolvedValue({
        id: 'ch-default',
        name: 'general',
        webhookUrl: 'enc-url',
        webhookUrlNonce: 'nonce',
        isDefault: true,
        enabled: true,
      } as any);

      mockFetch.mockResolvedValue({ ok: true });

      const results = await dispatchSlackNotification(
        mockNotificationType as any,
        'Deploy Complete',
        'Service deployed',
        {},
        'env-1'
      );

      expect(results).toHaveLength(1);
      expect(results[0].channelName).toBe('general');
    });

    it('should skip disabled channels', async () => {
      mockPrisma.slackTypeRouting.findMany.mockResolvedValue([
        {
          channel: {
            id: 'ch-1',
            name: 'alerts',
            webhookUrl: 'enc-url',
            webhookUrlNonce: 'nonce',
            enabled: false,
          },
          environmentIds: null,
        },
      ] as any);
      mockPrisma.slackChannel.findFirst.mockResolvedValue(null);

      const results = await dispatchSlackNotification(
        mockNotificationType as any,
        'Alert',
        'Something happened',
        {},
        'env-1'
      );

      expect(results).toEqual([]);
    });

    it('should filter by environment when environmentIds is set', async () => {
      mockPrisma.slackTypeRouting.findMany.mockResolvedValue([
        {
          channel: {
            id: 'ch-1',
            name: 'prod-alerts',
            webhookUrl: 'enc-url',
            webhookUrlNonce: 'nonce',
            enabled: true,
          },
          environmentIds: JSON.stringify(['env-prod']),
        },
      ] as any);
      mockPrisma.slackChannel.findFirst.mockResolvedValue(null);

      // env-1 is not in the allowed list
      const results = await dispatchSlackNotification(
        mockNotificationType as any,
        'Alert',
        'Something happened',
        {},
        'env-1'
      );

      expect(results).toEqual([]);
    });
  });

  describe('testSlackChannel', () => {
    it('should return error when channel not found', async () => {
      mockPrisma.slackChannel.findUnique.mockResolvedValue(null);

      const result = await testSlackChannel('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Channel not found');
    });

    it('should return error when no webhook URL configured', async () => {
      mockPrisma.slackChannel.findUnique.mockResolvedValue({
        id: 'ch-1',
        webhookUrl: null,
        webhookUrlNonce: null,
      } as any);

      const result = await testSlackChannel('ch-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No webhook URL');
    });

    it('should send test message and update lastTestedAt on success', async () => {
      mockPrisma.slackChannel.findUnique.mockResolvedValue({
        id: 'ch-1',
        name: 'test-channel',
        webhookUrl: 'enc-url',
        webhookUrlNonce: 'nonce',
      } as any);
      mockPrisma.slackChannel.update.mockResolvedValue({} as any);
      mockFetch.mockResolvedValue({ ok: true });

      const result = await testSlackChannel('ch-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.slackChannel.update).toHaveBeenCalledWith({
        where: { id: 'ch-1' },
        data: { lastTestedAt: expect.any(Date) },
      });
    });

    it('should not update lastTestedAt on failure', async () => {
      mockPrisma.slackChannel.findUnique.mockResolvedValue({
        id: 'ch-1',
        name: 'test-channel',
        webhookUrl: 'enc-url',
        webhookUrlNonce: 'nonce',
      } as any);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Server Error'),
      });

      const result = await testSlackChannel('ch-1');

      expect(result.success).toBe(false);
      expect(mockPrisma.slackChannel.update).not.toHaveBeenCalled();
    });
  });
});
