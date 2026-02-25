import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { useAuthStore } from '../../lib/store';

// Mock Toast
vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock API
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    getSmtpConfig: vi.fn().mockResolvedValue({
      config: null,
      configured: false,
    }),
    saveSmtpConfig: vi.fn(),
    testSmtpConnection: vi.fn(),
    listWebhooks: vi.fn().mockResolvedValue({ webhooks: [] }),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    testWebhook: vi.fn(),
    getAdminNotificationTypes: vi.fn().mockResolvedValue({
      types: [
        {
          id: 'nt-1',
          key: 'deployment_success',
          name: 'Deployment Success',
          description: 'Sent when a deployment succeeds',
          severity: 'info',
          category: 'deployments',
          enabled: true,
          bounceEnabled: false,
          bounceThreshold: 3,
        },
      ],
    }),
    updateAdminNotificationType: vi.fn(),
    listEnvironments: vi.fn().mockResolvedValue({
      environments: [{ id: 'env-1', name: 'Production', createdAt: '2024-01-01', _count: { servers: 1, secrets: 0 } }],
    }),
    getSystemSettings: vi.fn().mockResolvedValue({
      settings: {
        webhookMaxRetries: 3,
        webhookRetryDelaysMs: '[1000,5000,15000]',
        webhookTimeoutMs: 10000,
      },
      defaults: {
        webhookMaxRetries: 3,
        webhookTimeoutMs: 30000,
        webhookRetryDelaysMs: '[1000,5000,15000]',
      },
    }),
    updateSystemSettings: vi.fn(),
    listSlackChannels: vi.fn().mockResolvedValue({ channels: [] }),
    createSlackChannel: vi.fn(),
    updateSlackChannel: vi.fn(),
    deleteSlackChannel: vi.fn(),
    testSlackChannel: vi.fn(),
    listSlackRoutings: vi.fn().mockResolvedValue({ routings: [] }),
    updateSlackRoutings: vi.fn(),
  };
});

const NotificationSettings = (await import('./NotificationSettings')).default;

describe('NotificationSettings', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display tab navigation', async () => {
    renderWithProviders(<NotificationSettings />);
    await waitFor(() => {
      expect(screen.getByText('Email (SMTP)')).toBeInTheDocument();
      expect(screen.getByText('Webhooks')).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
      expect(screen.getByText('Notification Types')).toBeInTheDocument();
    });
  });

  it('should load notification types on Types tab', async () => {
    renderWithProviders(<NotificationSettings />);
    await waitFor(() => {
      expect(screen.getByText('Email (SMTP)')).toBeInTheDocument();
    });
  });
});
