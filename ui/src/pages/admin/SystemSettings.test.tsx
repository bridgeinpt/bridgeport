import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { ConfirmProvider } from '../../hooks/useConfirm';

// Mock API
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    getSystemSettings: vi.fn().mockResolvedValue({
      settings: {
        sshCommandTimeoutMs: 30000,
        sshReadyTimeoutMs: 10000,
        maxUploadSizeMb: 50,
        activeUserWindowMin: 15,
        registryMaxTags: 100,
        defaultLogLines: 200,
        publicUrl: '',
        agentCallbackUrl: '',
        agentStaleThresholdMs: 120000,
        agentOfflineThresholdMs: 300000,
        auditLogRetentionDays: 90,
        databaseMetricsRetentionDays: 30,
      },
      defaults: {
        sshCommandTimeoutMs: 30000,
        sshReadyTimeoutMs: 10000,
        maxUploadSizeMb: 50,
        activeUserWindowMin: 15,
        registryMaxTags: 100,
        defaultLogLines: 200,
        agentStaleThresholdMs: 120000,
        agentOfflineThresholdMs: 300000,
        auditLogRetentionDays: 90,
      },
    }),
    updateSystemSettings: vi.fn(),
    resetSystemSettings: vi.fn(),
  };
});

const SystemSettings = (await import('./SystemSettings')).default;

describe('SystemSettings', () => {
  it('should display settings sections', async () => {
    renderWithProviders(
      <ConfirmProvider>
        <SystemSettings />
      </ConfirmProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('SSH Configuration')).toBeInTheDocument();
    });
  });

  it('should load and display setting values', async () => {
    renderWithProviders(
      <ConfirmProvider>
        <SystemSettings />
      </ConfirmProvider>
    );
    await waitFor(() => {
      // SSH command timeout (30s) and databaseMetricsRetentionDays (30) both have value 30
      const inputs = screen.getAllByDisplayValue('30');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });
});
