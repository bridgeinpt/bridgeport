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
        expect(info.ports).toContainEqual({ host: 8080, container: 80, protocol: 'tcp' });
        expect(info.ports).toContainEqual({ host: null, container: 443, protocol: 'tcp' });
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
