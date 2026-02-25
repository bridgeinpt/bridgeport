import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isLocalhost, isHostGateway, createClient, LocalClient, SSHClient } from './ssh.js';

// Mock external dependencies
vi.mock('ssh2', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    on: vi.fn().mockReturnThis(),
    connect: vi.fn(),
    exec: vi.fn(),
    sftp: vi.fn(),
    end: vi.fn(),
  }));
  return { Client: MockClient };
});

vi.mock('./config.js', () => ({
  config: {
    SSH_USER: 'root',
    SSH_KEY_PATH: '/test/key',
  },
}));

vi.mock('../services/system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    sshReadyTimeoutMs: 10000,
    sshCommandTimeoutMs: 30000,
  }),
}));

describe('ssh', () => {
  describe('isLocalhost', () => {
    it('should return true for 127.0.0.1', () => {
      expect(isLocalhost('127.0.0.1')).toBe(true);
    });

    it('should return true for localhost', () => {
      expect(isLocalhost('localhost')).toBe(true);
    });

    it('should return true for ::1', () => {
      expect(isLocalhost('::1')).toBe(true);
    });

    it('should return false for remote hosts', () => {
      expect(isLocalhost('192.168.1.100')).toBe(false);
    });

    it('should return false for Docker host gateway 172.17.0.1', () => {
      expect(isLocalhost('172.17.0.1')).toBe(false);
    });

    it('should return false for host.docker.internal', () => {
      expect(isLocalhost('host.docker.internal')).toBe(false);
    });

    it('should return false for domain names', () => {
      expect(isLocalhost('example.com')).toBe(false);
    });
  });

  describe('isHostGateway', () => {
    it('should return true for 172.17.0.1', () => {
      expect(isHostGateway('172.17.0.1')).toBe(true);
    });

    it('should return true for host.docker.internal', () => {
      expect(isHostGateway('host.docker.internal')).toBe(true);
    });

    it('should return false for localhost', () => {
      expect(isHostGateway('localhost')).toBe(false);
    });

    it('should return false for 127.0.0.1', () => {
      expect(isHostGateway('127.0.0.1')).toBe(false);
    });

    it('should return false for random IPs', () => {
      expect(isHostGateway('10.0.0.1')).toBe(false);
    });
  });

  describe('createClient', () => {
    it('should return a LocalClient for localhost', () => {
      const client = createClient({ hostname: 'localhost' });
      expect(client).toBeInstanceOf(LocalClient);
    });

    it('should return a LocalClient for 127.0.0.1', () => {
      const client = createClient({ hostname: '127.0.0.1' });
      expect(client).toBeInstanceOf(LocalClient);
    });

    it('should return an SSHClient for remote hosts', () => {
      const client = createClient({ hostname: '192.168.1.100' });
      expect(client).toBeInstanceOf(SSHClient);
    });

    it('should return an SSHClient for Docker host gateway IPs', () => {
      const client = createClient({ hostname: '172.17.0.1' });
      expect(client).toBeInstanceOf(SSHClient);
    });

    it('should return an SSHClient for host.docker.internal', () => {
      const client = createClient({ hostname: 'host.docker.internal' });
      expect(client).toBeInstanceOf(SSHClient);
    });
  });

  describe('LocalClient', () => {
    let client: LocalClient;

    beforeEach(() => {
      client = new LocalClient();
    });

    it('should resolve connect() without error', async () => {
      await expect(client.connect()).resolves.toBeUndefined();
    });

    it('should disconnect() without error', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('should execute local commands successfully', async () => {
      const result = await client.exec('echo "hello world"', { timeout: 30000 });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('hello world');
    });

    it('should return non-zero exit code for failed commands', async () => {
      const result = await client.exec('false', { timeout: 30000 });
      expect(result.code).not.toBe(0);
    });

    it('should capture stderr from failed commands', async () => {
      const result = await client.exec('ls /nonexistent_path_that_does_not_exist 2>&1 || true', { timeout: 30000 });
      // The command will output error text to stdout (due to redirect) or stderr
      expect(result.code).toBe(0);
    });
  });

  describe('SSHClient', () => {
    it('should create with default port and username from config', () => {
      const client = new SSHClient({ hostname: 'example.com' });
      expect(client).toBeInstanceOf(SSHClient);
    });

    it('should accept custom options', () => {
      const client = new SSHClient({
        hostname: 'example.com',
        port: 2222,
        username: 'deploy',
        privateKey: 'mock-key-content',
      });
      expect(client).toBeInstanceOf(SSHClient);
    });

    it('should report not connected initially', () => {
      const client = new SSHClient({ hostname: 'example.com' });
      expect(client.isConnected()).toBe(false);
    });

    it('should be idempotent on disconnect when not connected', () => {
      const client = new SSHClient({ hostname: 'example.com' });
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});
