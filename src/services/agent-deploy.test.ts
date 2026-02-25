import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockSSHClientInstance, mockLocalClientInstance } = vi.hoisted(() => ({
  mockPrisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockSSHClientInstance: {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ code: 0, stdout: 'active', stderr: '' }),
    disconnect: vi.fn(),
  },
  mockLocalClientInstance: {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ code: 0, stdout: 'active', stderr: '' }),
    disconnect: vi.fn(),
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn().mockImplementation(function() { return mockSSHClientInstance; }),
  LocalClient: vi.fn().mockImplementation(function() { return mockLocalClientInstance; }),
  isLocalhost: vi.fn().mockReturnValue(false),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({
    username: 'root',
    privateKey: 'fake-key',
  }),
}));

vi.mock('./system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    agentCallbackUrl: 'http://bridgeport:3000',
  }),
}));

vi.mock('./agent-events.js', () => ({
  logAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-binary-content')),
}));

import { generateAgentToken, deployAgent, removeAgent, checkAgentStatus } from './agent-deploy.js';
import { isLocalhost, SSHClient, LocalClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { logAgentEvent } from './agent-events.js';
import { readFile } from 'fs/promises';

describe('agent-deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockSSHClientInstance.connect.mockResolvedValue(undefined);
    mockSSHClientInstance.exec.mockResolvedValue({ code: 0, stdout: 'active', stderr: '' });
    mockLocalClientInstance.connect.mockResolvedValue(undefined);
    mockLocalClientInstance.exec.mockResolvedValue({ code: 0, stdout: 'active', stderr: '' });
  });

  describe('generateAgentToken', () => {
    it('should return a base64url encoded string', () => {
      const token = generateAgentToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      // Base64url characters only
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 10; i++) {
        tokens.add(generateAgentToken());
      }
      expect(tokens.size).toBe(10);
    });
  });

  describe('deployAgent', () => {
    const mockServer = {
      id: 'server-1',
      hostname: '10.0.0.1',
      environmentId: 'env-1',
      agentToken: null,
      environment: { id: 'env-1', name: 'test' },
    };

    beforeEach(() => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockPrisma.server.update.mockResolvedValue({ ...mockServer, agentToken: 'new-token' });
    });

    it('should return error when server not found', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);

      const result = await deployAgent('nonexistent');

      expect(result).toEqual({ success: false, error: 'Server not found' });
    });

    it('should return error when callback URL not configured', async () => {
      const { getSystemSettings } = await import('./system-settings.js');
      vi.mocked(getSystemSettings).mockResolvedValueOnce({
        agentCallbackUrl: null,
      } as any);

      const result = await deployAgent('server-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent Callback URL');
    });

    it('should return error when agent binary not found', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await deployAgent('server-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent binary not found');
    });

    it('should generate agent token if server has no token', async () => {
      const serverNoToken = { ...mockServer, agentToken: null };
      mockPrisma.server.findUnique.mockResolvedValue(serverNoToken);

      await deployAgent('server-1');

      // Should have an update call that sets agentToken
      const tokenUpdateCall = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.agentToken
      );
      expect(tokenUpdateCall).toBeDefined();
    });

    it('should use LocalClient for localhost hostname', async () => {
      vi.mocked(isLocalhost).mockReturnValueOnce(true);
      const localServer = { ...mockServer, hostname: 'localhost' };
      mockPrisma.server.findUnique.mockResolvedValue(localServer);

      await deployAgent('server-1');

      expect(LocalClient).toHaveBeenCalled();
    });

    it('should use SSHClient for remote hostname', async () => {
      vi.mocked(isLocalhost).mockReturnValue(false);

      await deployAgent('server-1');

      expect(SSHClient).toHaveBeenCalled();
    });

    it('should return error when SSH key not configured for remote server', async () => {
      vi.mocked(isLocalhost).mockReturnValue(false);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);

      const result = await deployAgent('server-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH key not configured');
    });

    it('should log deploy_started event', async () => {
      await deployAgent('server-1');

      expect(logAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'server-1',
          eventType: 'deploy_started',
        })
      );
    });

    it('should set agent status to deploying', async () => {
      await deployAgent('server-1');

      const deployingCall = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.agentStatus === 'deploying'
      );
      expect(deployingCall).toBeDefined();
    });

    it('should accept explicit bridgeport URL parameter', async () => {
      await deployAgent('server-1', 'http://custom-url:3000');

      expect(logAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ serverUrl: 'http://custom-url:3000' }),
        })
      );
    });

    it('should log deploy_failed and reset status on SSH transfer error', async () => {
      mockSSHClientInstance.exec
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // stop service
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // rm temp
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Transfer failed' }); // chunk write fails

      const result = await deployAgent('server-1');

      expect(result.success).toBe(false);
      expect(logAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'deploy_failed' })
      );
      // Should reset agentStatus to unknown
      const resetCall = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.agentStatus === 'unknown'
      );
      expect(resetCall).toBeDefined();
    });
  });

  describe('removeAgent', () => {
    const mockServer = {
      id: 'server-1',
      hostname: '10.0.0.1',
      environmentId: 'env-1',
      environment: { id: 'env-1' },
    };

    it('should return error when server not found', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);

      const result = await removeAgent('nonexistent');

      expect(result).toEqual({ success: false, error: 'Server not found' });
    });

    it('should stop service, remove files, and update server', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockPrisma.server.update.mockResolvedValue({});

      const result = await removeAgent('server-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'server-1' },
        data: { metricsMode: 'disabled', agentToken: null },
      });
    });

    it('should return error when SSH key not configured for remote server', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      vi.mocked(isLocalhost).mockReturnValue(false);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);

      const result = await removeAgent('server-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH key not configured');
    });

    it('should handle SSH errors gracefully', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockSSHClientInstance.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await removeAgent('server-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('checkAgentStatus', () => {
    const mockServer = {
      id: 'server-1',
      hostname: '10.0.0.1',
      environmentId: 'env-1',
      environment: { id: 'env-1' },
    };

    it('should return error when server not found', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);

      const result = await checkAgentStatus('nonexistent');

      expect(result).toEqual({
        installed: false,
        running: false,
        error: 'Server not found',
      });
    });

    it('should check binary existence and service status', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockSSHClientInstance.exec
        .mockResolvedValueOnce({ code: 0, stdout: 'yes', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: 'active', stderr: '' });

      const result = await checkAgentStatus('server-1');

      expect(result).toEqual({ installed: true, running: true });
    });

    it('should report not installed when binary missing', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockSSHClientInstance.exec
        .mockResolvedValueOnce({ code: 0, stdout: 'no', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: 'inactive', stderr: '' });

      const result = await checkAgentStatus('server-1');

      expect(result).toEqual({ installed: false, running: false });
    });

    it('should return error when SSH connection fails', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      mockSSHClientInstance.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await checkAgentStatus('server-1');

      expect(result).toEqual({
        installed: false,
        running: false,
        error: 'Connection refused',
      });
    });

    it('should return error when SSH key not configured', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(mockServer);
      vi.mocked(isLocalhost).mockReturnValue(false);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);

      const result = await checkAgentStatus('server-1');

      expect(result).toEqual({
        installed: false,
        running: false,
        error: 'SSH key not configured',
      });
    });
  });
});
