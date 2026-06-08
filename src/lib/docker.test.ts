import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerSSHClient, createDockerClient } from './docker.js';
import type { CommandClient, SSHExecResult } from './ssh.js';

/**
 * Creates a mock CommandClient for testing DockerSSHClient.
 */
function createMockCommandClient(responses?: Map<string, SSHExecResult>): CommandClient {
  const defaultResponse: SSHExecResult = { stdout: '', stderr: '', code: 0 };

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockImplementation(async (command: string) => {
      if (responses) {
        for (const [pattern, result] of responses) {
          if (command.includes(pattern)) return result;
        }
      }
      return defaultResponse;
    }),
    execStream: vi.fn().mockResolvedValue(0),
    writeFile: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
}

describe('docker', () => {
  describe('DockerSSHClient', () => {
    describe('listContainers', () => {
      it('should parse docker ps output into container list', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker ps', {
            stdout: 'abc123456789|my-app|nginx:latest|Up 2 hours|running\ndef987654321|my-db|postgres:15|Up 2 hours|running\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const containers = await docker.listContainers();

        expect(containers).toEqual([
          { id: 'abc123456789', name: 'my-app', image: 'nginx:latest', status: 'Up 2 hours', state: 'running' },
          { id: 'def987654321', name: 'my-db', image: 'postgres:15', status: 'Up 2 hours', state: 'running' },
        ]);
      });

      it('should return empty array when no containers exist', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker ps', { stdout: '', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const containers = await docker.listContainers();
        expect(containers).toEqual([]);
      });

      it('should throw when docker ps fails', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker ps', { stdout: '', stderr: 'docker not found', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.listContainers()).rejects.toThrow('Failed to list containers');
      });
    });

    describe('getContainerInfo', () => {
      it('should parse container info with ports', async () => {
        const portsJson = JSON.stringify({
          '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
          '443/tcp': null,
        });
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: `running|true|healthy|nginx:latest|${portsJson}\n`,
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const info = await docker.getContainerInfo('my-container');

        expect(info.state).toBe('running');
        expect(info.running).toBe(true);
        expect(info.health).toBe('healthy');
        expect(info.image).toBe('nginx:latest');
        expect(info.ports).toContainEqual({ host: 8080, container: 80, protocol: 'tcp', hostIp: '0.0.0.0' });
        expect(info.ports).toContainEqual({ host: null, container: 443, protocol: 'tcp', hostIp: null });
      });

      it('should return not_found when container does not exist', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'not_found|false|||{}\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const info = await docker.getContainerInfo('nonexistent');

        expect(info.state).toBe('not_found');
        expect(info.running).toBe(false);
        expect(info.ports).toEqual([]);
      });

      it('should handle <no value> health status', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'running|true|<no value>|nginx:latest|{}\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const info = await docker.getContainerInfo('my-container');

        expect(info.health).toBeUndefined();
      });

      it('should handle empty health status', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'running|true||nginx:latest|{}\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const info = await docker.getContainerInfo('my-container');

        expect(info.health).toBeUndefined();
      });
    });

    describe('getContainerHealth', () => {
      it('should parse healthy running container', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'running|true|healthy\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const health = await docker.getContainerHealth('my-container');

        expect(health.state).toBe('running');
        expect(health.running).toBe(true);
        expect(health.status).toBe('Running');
        expect(health.health).toBe('healthy');
      });

      it('should parse stopped container', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'exited|false|\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const health = await docker.getContainerHealth('my-container');

        expect(health.state).toBe('exited');
        expect(health.running).toBe(false);
        expect(health.status).toBe('Container is exited');
      });

      it('should return not_found for missing containers', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', {
            stdout: 'not_found|false|\n',
            stderr: '',
            code: 0,
          }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const health = await docker.getContainerHealth('nonexistent');

        expect(health.state).toBe('not_found');
        expect(health.status).toBe('Container not found');
      });
    });

    describe('getContainerEnv (drift, read-only)', () => {
      it('should parse .Config.Env JSON into a key->value map', async () => {
        const envJson = JSON.stringify(['FOO=bar', 'PATH=/usr/bin', 'EMPTY=']);
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: envJson + '\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('my-container');

        expect(env).toEqual({ FOO: 'bar', PATH: '/usr/bin', EMPTY: '' });
      });

      it('should split only on the first = (values may contain =)', async () => {
        const envJson = JSON.stringify(['DATABASE_URL=postgres://u:p@h/db?x=1']);
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: envJson + '\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('my-container');

        expect(env).toEqual({ DATABASE_URL: 'postgres://u:p@h/db?x=1' });
      });

      it('should return null when the container is not found', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: '__not_found__\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('nonexistent');

        expect(env).toBeNull();
      });

      it('should return null when the command exits non-zero', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: '', stderr: 'boom', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('my-container');

        expect(env).toBeNull();
      });

      it('should return an empty map for a null/empty .Config.Env', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: 'null\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('my-container');

        expect(env).toEqual({});
      });

      it('should ignore malformed entries without an =', async () => {
        const envJson = JSON.stringify(['GOOD=1', 'JUSTAKEY', '=onlyvalue']);
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: envJson + '\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const env = await docker.getContainerEnv('my-container');

        // 'JUSTAKEY' has no '=' and is dropped; '=onlyvalue' splits to an empty key.
        expect(env).toEqual({ GOOD: '1', '': 'onlyvalue' });
      });

      it('should shell-escape the container name (read-only inspect)', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker inspect', { stdout: '[]\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerEnv('evil; rm -rf /');

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cmd).toContain(`'evil; rm -rf /'`);
        expect(cmd).toContain('docker inspect');
        // Read-only invariant: never a mutating verb.
        expect(cmd).not.toMatch(/docker (rm|stop|kill|restart|run|up|down|pull)\b/);
      });
    });

    describe('getContainerImageDigests (drift, read-only)', () => {
      it('should return imageRef, configDigest, and RepoDigests', async () => {
        const repoDigests = JSON.stringify(['nginx@sha256:aaa', 'nginx@sha256:bbb']);
        const mockClient = createMockCommandClient(new Map([
          // Container inspect: '{{.Config.Image}}|{{.Image}}'
          ['{{.Config.Image}}|{{.Image}}', {
            stdout: 'nginx:1.25|sha256:localid\n',
            stderr: '',
            code: 0,
          }],
          // Image inspect for RepoDigests: '{{json .RepoDigests}}'
          ['json .RepoDigests', { stdout: repoDigests + '\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const result = await docker.getContainerImageDigests('my-container');

        expect(result.found).toBe(true);
        expect(result.imageRef).toBe('nginx:1.25');
        expect(result.configDigest).toBe('sha256:localid');
        expect(result.repoDigests).toEqual(['nginx@sha256:aaa', 'nginx@sha256:bbb']);
      });

      it('should return found:false when the container is missing', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['{{.Config.Image}}|{{.Image}}', { stdout: '__not_found__\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const result = await docker.getContainerImageDigests('nonexistent');

        expect(result).toEqual({ found: false, imageRef: '', repoDigests: [], configDigest: '' });
      });

      it('should fall back to empty repoDigests for a locally-built image', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['{{.Config.Image}}|{{.Image}}', { stdout: 'myapp:dev|sha256:local\n', stderr: '', code: 0 }],
          // Image has no RepoDigests (locally built / never pulled by digest).
          ['json .RepoDigests', { stdout: '[]\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const result = await docker.getContainerImageDigests('my-container');

        expect(result.found).toBe(true);
        expect(result.imageRef).toBe('myapp:dev');
        expect(result.repoDigests).toEqual([]);
      });

      it('should not fail the whole call when the image-inspect step errors', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['{{.Config.Image}}|{{.Image}}', { stdout: 'nginx:1.25|sha256:local\n', stderr: '', code: 0 }],
          ['json .RepoDigests', { stdout: '', stderr: 'no such image', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const result = await docker.getContainerImageDigests('my-container');

        expect(result.found).toBe(true);
        expect(result.repoDigests).toEqual([]);
      });

      it('should issue only read-only docker inspect commands', async () => {
        const repoDigests = JSON.stringify(['nginx@sha256:aaa']);
        const calls: string[] = [];
        const mockClient = createMockCommandClient(new Map([
          ['{{.Config.Image}}|{{.Image}}', { stdout: 'nginx:1.25|sha256:local\n', stderr: '', code: 0 }],
          ['json .RepoDigests', { stdout: repoDigests + '\n', stderr: '', code: 0 }],
        ]));
        const origExec = mockClient.exec;
        mockClient.exec = vi.fn(async (cmd: string) => {
          calls.push(cmd);
          return (origExec as (c: string) => Promise<SSHExecResult>)(cmd);
        });

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerImageDigests('my-container');

        expect(calls.length).toBeGreaterThan(0);
        for (const cmd of calls) {
          expect(cmd).toContain('docker inspect');
          expect(cmd).not.toMatch(/docker (rm|stop|kill|restart|run|up|down|pull)\b/);
        }
      });
    });

    describe('getContainerStats', () => {
      it('should parse CPU, memory, network, and block IO stats', async () => {
        const statsJson = JSON.stringify({
          CPUPerc: '15.25%',
          MemUsage: '256MiB / 1GiB',
          NetIO: '10.5MB / 5.2MB',
          BlockIO: '100MB / 50MB',
        });
        const mockClient = createMockCommandClient(new Map([
          ['docker stats', { stdout: statsJson + '\n', stderr: '', code: 0 }],
          ['docker inspect', { stdout: '3\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const stats = await docker.getContainerStats('my-container');

        expect(stats.cpuPercent).toBe(15.25);
        expect(stats.memoryUsedMb).toBe(256);
        expect(stats.memoryLimitMb).toBeCloseTo(1024);
        expect(stats.restartCount).toBe(3);
      });

      it('should return empty stats on failure', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker stats', { stdout: '', stderr: 'error', code: 1 }],
          ['docker inspect', { stdout: '', stderr: 'error', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const stats = await docker.getContainerStats('my-container');

        expect(stats.cpuPercent).toBeUndefined();
        expect(stats.memoryUsedMb).toBeUndefined();
      });

      it('should handle invalid JSON from docker stats', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker stats', { stdout: 'not json\n', stderr: '', code: 0 }],
          ['docker inspect', { stdout: '0\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const stats = await docker.getContainerStats('my-container');

        // Should not throw, just return whatever it could parse
        expect(stats.restartCount).toBe(0);
      });
    });

    describe('restartContainer', () => {
      it('should execute docker restart command', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker restart', { stdout: 'my-container\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.restartContainer('my-container')).resolves.toBeUndefined();
        expect(mockClient.exec).toHaveBeenCalledWith(
          expect.stringContaining('docker restart my-container')
        );
      });

      it('should throw on restart failure', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker restart', { stdout: '', stderr: 'Container not found', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.restartContainer('bad-container'))
          .rejects.toThrow('Failed to restart container');
      });
    });

    describe('pullImage', () => {
      it('should execute docker pull command', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker pull', { stdout: 'Pulling...\nDone\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.pullImage('nginx:latest')).resolves.toBeUndefined();
        expect(mockClient.exec).toHaveBeenCalledWith(
          expect.stringContaining('docker pull nginx:latest')
        );
      });

      it('should throw on pull failure', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker pull', { stdout: '', stderr: 'manifest unknown', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.pullImage('nonexistent:tag'))
          .rejects.toThrow('Failed to pull image');
      });
    });

    describe('getContainerLogs', () => {
      it('should return combined stdout and stderr', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: 'log line 1\nlog line 2\n', stderr: 'warning\n', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const logs = await docker.getContainerLogs('my-container');

        expect(logs).toBe('log line 1\nlog line 2\nwarning\n');
      });

      it('should pass tail option', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: 'last line\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container', { tail: 50 });

        expect(mockClient.exec).toHaveBeenCalledWith(
          expect.stringContaining('--tail 50')
        );
      });

      it('should throw on logs failure', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: '', stderr: 'no such container', code: 1 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await expect(docker.getContainerLogs('nonexistent'))
          .rejects.toThrow('Failed to get logs');
      });

      it('should add -t flag when timestamps is true', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: '2026-05-20T10:00:00Z hello\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container', { timestamps: true });

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cmd).toMatch(/\bdocker logs\b.*\B-t\b/);
      });

      it('should not add -t flag when timestamps is false or omitted', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: 'hello\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container');

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        // The container name 'my-container' contains 't', so we have to check
        // for ` -t ` as a token, not just the letter.
        expect(cmd).not.toMatch(/\s-t\s/);
        expect(cmd).not.toMatch(/\s-t$/);
      });

      it('should pass --until with shell-escaped value', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: '', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container', { until: '2026-05-20T10:00:00Z' });

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cmd).toContain(`--until '2026-05-20T10:00:00Z'`);
      });

      it('should shell-escape a malicious until value', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: '', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container', { until: `2026-05-20'; rm -rf /; echo '` });

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        // The malicious quote must be escaped, so the surrounding single-quote
        // structure remains intact and no unescaped `rm -rf /` can run as a
        // separate command.
        expect(cmd).not.toMatch(/--until '2026-05-20'; rm -rf/);
        expect(cmd).toContain(`'\\''`);
      });

      it('should shell-escape the container name', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: '', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs(`evil; rm -rf /`);

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cmd).toContain(`'evil; rm -rf /'`);
        // Must not appear as a separate shell command.
        expect(cmd).not.toMatch(/;\s*rm -rf \/\s*$/);
      });

      it('should combine tail, timestamps, until and escaped name', async () => {
        const mockClient = createMockCommandClient(new Map([
          ['docker logs', { stdout: 'log\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        await docker.getContainerLogs('my-container', {
          tail: 25,
          timestamps: true,
          until: '2026-05-20T10:00:00Z',
        });

        const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cmd).toContain('--tail 25');
        expect(cmd).toContain(' -t ');
        expect(cmd).toContain(`--until '2026-05-20T10:00:00Z'`);
        expect(cmd).toContain(`'my-container'`);
      });
    });

    describe('convertToMb (via stats parsing)', () => {
      it('should convert GiB to MB correctly', async () => {
        const statsJson = JSON.stringify({
          MemUsage: '2GiB / 4GiB',
        });
        const mockClient = createMockCommandClient(new Map([
          ['docker stats', { stdout: statsJson + '\n', stderr: '', code: 0 }],
          ['docker inspect', { stdout: '0\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const stats = await docker.getContainerStats('my-container');

        expect(stats.memoryUsedMb).toBeCloseTo(2048);
        expect(stats.memoryLimitMb).toBeCloseTo(4096);
      });

      it('should convert KiB to MB correctly', async () => {
        const statsJson = JSON.stringify({
          MemUsage: '512KiB / 1024KiB',
        });
        const mockClient = createMockCommandClient(new Map([
          ['docker stats', { stdout: statsJson + '\n', stderr: '', code: 0 }],
          ['docker inspect', { stdout: '0\n', stderr: '', code: 0 }],
        ]));

        const docker = new DockerSSHClient(mockClient);
        const stats = await docker.getContainerStats('my-container');

        expect(stats.memoryUsedMb).toBeCloseTo(0.5);
        expect(stats.memoryLimitMb).toBeCloseTo(1);
      });
    });
  });

  describe('createDockerClient', () => {
    it('should create a socket client for socket mode', () => {
      const client = createDockerClient({ mode: 'socket' });
      expect(client).toBeDefined();
      // DockerSocketClient instance check
      expect(client.listContainers).toBeDefined();
    });

    it('should create an SSH client for ssh mode', () => {
      const mockCommandClient = createMockCommandClient();
      const client = createDockerClient({ mode: 'ssh', sshClient: mockCommandClient });
      expect(client).toBeDefined();
    });

    it('should throw when ssh mode has no client', () => {
      expect(() => createDockerClient({ mode: 'ssh' }))
        .toThrow('SSH client required for SSH mode');
    });
  });
});
