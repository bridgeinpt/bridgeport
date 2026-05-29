import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isLocalhost, isHostGateway, createClient, LocalClient, SSHClient, DockerSSH, type CommandClient } from './ssh.js';

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

  describe('DockerSSH.login', () => {
    function makeMockClient(): CommandClient & { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> } {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        execStream: vi.fn(),
        exec: vi.fn().mockResolvedValue({ stdout: 'Login Succeeded', stderr: '', code: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as never;
    }

    it('writes the password to a temp file, never as a CLI arg, then cleans up', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.login('registry.example.com', 'alice', 'p@ss with spaces');

      // writeFile carries the secret — confirm it's a Buffer of the password content.
      expect(client.writeFile).toHaveBeenCalledTimes(1);
      const [tmpPath, content] = client.writeFile.mock.calls[0];
      expect(typeof tmpPath).toBe('string');
      expect(tmpPath).toMatch(/^\/tmp\/bp-login-/);
      expect(Buffer.isBuffer(content)).toBe(true);
      expect((content as Buffer).toString('utf8')).toBe('p@ss with spaces');

      // The password must never appear as a docker login argument.
      const execCalls = client.exec.mock.calls.map((c) => c[0] as string);
      for (const cmd of execCalls) {
        expect(cmd).not.toContain('p@ss with spaces');
      }

      // Expect: chmod, then cat | docker login --password-stdin, then rm.
      expect(execCalls[0]).toContain('chmod 600');
      expect(execCalls[1]).toContain('docker login');
      expect(execCalls[1]).toContain('--password-stdin');
      expect(execCalls[1]).toContain("'registry.example.com'");
      expect(execCalls[1]).toContain("'alice'");
      expect(execCalls[2]).toMatch(/^rm -f /);
    });

    it('omits the host argument when registryHost is empty (Docker Hub default)', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.login('', 'alice', 'hunter2');

      const loginCmd = client.exec.mock.calls[1][0] as string;
      // Docker Hub: the command should end with --password-stdin, no host arg.
      expect(loginCmd).toMatch(/--password-stdin$/);
    });

    it('removes the temp file even when docker login fails', async () => {
      const client = makeMockClient();
      // chmod ok, docker login fails, rm ok.
      client.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'unauthorized', code: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
      const docker = new DockerSSH(client);

      await expect(docker.login('registry.example.com', 'alice', 'wrong')).rejects.toThrow(
        /docker login failed/
      );

      const lastCall = client.exec.mock.calls[client.exec.mock.calls.length - 1][0] as string;
      expect(lastCall).toMatch(/^rm -f /);
    });
  });

  describe('DockerSSH.containerLogs', () => {
    function makeMockClient(): CommandClient & { exec: ReturnType<typeof vi.fn> } {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        execStream: vi.fn(),
        exec: vi.fn().mockResolvedValue({ stdout: 'logs out\n', stderr: 'logs err\n', code: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as never;
    }

    it('returns stdout + stderr combined', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      const out = await docker.containerLogs('my-container');
      expect(out).toBe('logs out\nlogs err\n');
    });

    it('shell-escapes the container name', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs(`evil; rm -rf /`);

      const cmd = client.exec.mock.calls[0][0] as string;
      expect(cmd).toContain(`'evil; rm -rf /'`);
      expect(cmd).not.toMatch(/;\s*rm -rf \/\s*$/);
    });

    it('adds --tail when tail option is set', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container', { tail: 100 });

      const cmd = client.exec.mock.calls[0][0] as string;
      expect(cmd).toContain('--tail 100');
    });

    it('adds -t when timestamps option is true', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container', { timestamps: true });

      const cmd = client.exec.mock.calls[0][0] as string;
      expect(cmd).toMatch(/\bdocker logs\b.*\s-t\s/);
    });

    it('omits -t when timestamps option is false or absent', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container');

      const cmd = client.exec.mock.calls[0][0] as string;
      expect(cmd).not.toMatch(/\s-t\s/);
      expect(cmd).not.toMatch(/\s-t$/);
    });

    it('adds shell-escaped --until value', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container', { until: '2026-05-20T10:00:00Z' });

      const cmd = client.exec.mock.calls[0][0] as string;
      expect(cmd).toContain(`--until '2026-05-20T10:00:00Z'`);
    });

    it('shell-escapes a malicious --until value', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container', { until: `2026'; rm -rf /; echo '` });

      const cmd = client.exec.mock.calls[0][0] as string;
      // The single-quote in the value must be escaped using the `'\''` idiom.
      expect(cmd).toContain(`'\\''`);
      expect(cmd).not.toMatch(/--until '2026'; rm -rf/);
    });

    it('throws when docker logs exits non-zero', async () => {
      const client = makeMockClient();
      client.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no such container', code: 1 });
      const docker = new DockerSSH(client);

      await expect(docker.containerLogs('nonexistent')).rejects.toThrow(/Failed to get logs/);
    });

    it('composes all options in the expected order', async () => {
      const client = makeMockClient();
      const docker = new DockerSSH(client);

      await docker.containerLogs('my-container', {
        tail: 25,
        follow: true,
        timestamps: true,
        until: '2026-05-20T10:00:00Z',
      });

      const cmd = client.exec.mock.calls[0][0] as string;
      // Expected order: `docker logs --tail 25 -f -t --until '...' 'my-container'`
      expect(cmd).toMatch(
        /docker logs --tail 25 -f -t --until '2026-05-20T10:00:00Z' 'my-container'$/
      );
    });
  });

  describe('DockerSSH.composeUp', () => {
    // v2: the `docker compose version --short` plugin probe succeeds, so
    // getComposeInfo picks the v2 (`--force-recreate`) branch. exec calls are
    // [version, up].
    function makeV2Client(version: string) {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        execStream: vi.fn(),
        exec: vi
          .fn()
          .mockResolvedValueOnce({ stdout: version, stderr: '', code: 0 }) // plugin probe
          .mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as never;
    }

    // v1: the plugin probe FAILS and the standalone `docker-compose version
    // --short` probe succeeds, so getComposeInfo picks the v1 (rm + up)
    // workaround branch. exec calls are [plugin probe (fail), standalone probe,
    // rm, up]. Mocking the version directly would NOT reach v1 — getComposeInfo
    // forces majorVersion>=2 whenever the plugin probe answers.
    function makeV1Client(version: string) {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        execStream: vi.fn(),
        exec: vi
          .fn()
          .mockResolvedValueOnce({ stdout: '', stderr: 'not found', code: 1 }) // plugin probe fails
          .mockResolvedValueOnce({ stdout: version, stderr: '', code: 0 }) // standalone probe
          .mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as never;
    }

    it('adds --no-deps for a single service only when noDeps is set (v2)', async () => {
      const client = makeV2Client('2.24.0');
      const docker = new DockerSSH(client);

      await docker.composeUp('/opt/app/docker-compose.yml', 'frontend', true, true);

      const upCmd = client.exec.mock.calls[1][0] as string;
      expect(upCmd).toContain('up -d');
      expect(upCmd).toContain('--force-recreate');
      expect(upCmd).toContain('--no-deps');
      expect(upCmd).toMatch(/'frontend'$/);
    });

    it('omits --no-deps for a single service when noDeps is false (v2 default)', async () => {
      const client = makeV2Client('2.24.0');
      const docker = new DockerSSH(client);

      // Default noDeps=false: a standalone compose file must still start deps.
      await docker.composeUp('/opt/app/docker-compose.yml', 'frontend');

      const upCmd = client.exec.mock.calls[1][0] as string;
      expect(upCmd).toContain('--force-recreate');
      expect(upCmd).not.toContain('--no-deps');
      expect(upCmd).toMatch(/'frontend'$/);
    });

    it('does not add --no-deps when no service is targeted (v2 whole-file up)', async () => {
      const client = makeV2Client('2.24.0');
      const docker = new DockerSSH(client);

      await docker.composeUp('/opt/app/docker-compose.yml', undefined, true, true);

      const upCmd = client.exec.mock.calls[1][0] as string;
      expect(upCmd).not.toContain('--no-deps');
    });

    it('adds --no-deps on the v1 rm+up workaround path when noDeps is set', async () => {
      const client = makeV1Client('1.29.2');
      const docker = new DockerSSH(client);

      await docker.composeUp('/opt/app/docker-compose.yml', 'frontend', true, true);

      const cmds = client.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      // Confirm we genuinely hit the v1 branch: it issues `rm -f -s` before up.
      expect(cmds.some((c) => c.includes('rm -f -s'))).toBe(true);
      const upCmd = cmds.find((c) => c.includes('up -d'))!;
      expect(upCmd).toContain('docker-compose');
      expect(upCmd).toContain('--no-deps');
      expect(upCmd).toMatch(/'frontend'$/);
    });

    it('omits --no-deps on the v1 path when noDeps is false', async () => {
      const client = makeV1Client('1.29.2');
      const docker = new DockerSSH(client);

      await docker.composeUp('/opt/app/docker-compose.yml', 'frontend');

      const cmds = client.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(cmds.some((c) => c.includes('rm -f -s'))).toBe(true);
      const upCmd = cmds.find((c) => c.includes('up -d'))!;
      expect(upCmd).not.toContain('--no-deps');
    });
  });
});
