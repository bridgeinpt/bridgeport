import Docker from 'dockerode';
import { access, constants } from 'fs/promises';
import type { CommandClient } from './ssh.js';
import { CONTAINER_STATUS, DOCKER_MODE } from './constants.js';
import { safeJsonParse } from './helpers.js';

// ==================== Types ====================

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
}

export interface ContainerDetails {
  state: string;
  running: boolean;
  health?: string;
  ports: Array<{ host: number | null; container: number; protocol: string }>;
  image: string;
}

export interface ContainerHealth {
  state: string;
  status: string;
  health?: string;
  running: boolean;
}

export interface ContainerStats {
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryLimitMb?: number;
  networkRxMb?: number;
  networkTxMb?: number;
  blockReadMb?: number;
  blockWriteMb?: number;
  restartCount?: number;
}

export interface UrlCheckResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Abstract interface for Docker operations.
 * Implemented by both socket-based and SSH-based clients.
 */
export interface DockerClient {
  listContainers(): Promise<ContainerInfo[]>;
  getContainerInfo(containerName: string): Promise<ContainerDetails>;
  getContainerHealth(containerName: string): Promise<ContainerHealth>;
  getContainerStats(containerName: string): Promise<ContainerStats>;
  restartContainer(containerName: string): Promise<void>;
  pullImage(image: string): Promise<void>;
  getContainerLogs(containerName: string, options?: { tail?: number }): Promise<string>;
}

// ==================== Socket Implementation ====================

const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/**
 * Check if Docker socket is available and accessible
 */
export async function isDockerSocketAvailable(): Promise<boolean> {
  try {
    await access(DOCKER_SOCKET_PATH, constants.R_OK | constants.W_OK);

    // Try a ping to verify Docker daemon is responsive
    const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Docker client using Unix socket (dockerode).
 * Used for managing containers on the host machine.
 */
export class DockerSocketClient implements DockerClient {
  private docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({ all: true });

    return containers.map((c) => ({
      id: c.Id.substring(0, 12),
      name: c.Names[0]?.replace(/^\//, '') || '',
      image: c.Image,
      status: c.Status,
      state: c.State,
    }));
  }

  async getContainerInfo(containerName: string): Promise<ContainerDetails> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();

      // Parse ports from NetworkSettings
      const ports: Array<{ host: number | null; container: number; protocol: string }> = [];
      const portsData = info.NetworkSettings?.Ports || {};

      for (const [containerPort, bindings] of Object.entries(portsData)) {
        const [portStr, protocol] = containerPort.split('/');
        const containerPortNum = parseInt(portStr, 10);

        if (Array.isArray(bindings) && bindings.length > 0) {
          for (const binding of bindings) {
            ports.push({
              host: binding.HostPort ? parseInt(binding.HostPort, 10) : null,
              container: containerPortNum,
              protocol: protocol || 'tcp',
            });
          }
        } else {
          ports.push({
            host: null,
            container: containerPortNum,
            protocol: protocol || 'tcp',
          });
        }
      }

      const healthStatus = info.State?.Health?.Status;

      return {
        state: info.State?.Status || 'unknown',
        running: info.State?.Running || false,
        health: healthStatus && healthStatus !== '' ? healthStatus : undefined,
        ports,
        image: info.Config?.Image || '',
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { state: CONTAINER_STATUS.NOT_FOUND, running: false, ports: [], image: '' };
      }
      throw err;
    }
  }

  async getContainerHealth(containerName: string): Promise<ContainerHealth> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();

      const state = info.State?.Status || 'unknown';
      const running = info.State?.Running || false;
      const healthStatus = info.State?.Health?.Status;

      return {
        state,
        status: running ? 'Running' : `Container is ${state}`,
        health: healthStatus && healthStatus !== '' ? healthStatus : undefined,
        running,
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { state: CONTAINER_STATUS.NOT_FOUND, status: 'Container not found', running: false };
      }
      throw err;
    }
  }

  async getContainerStats(containerName: string): Promise<ContainerStats> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      const stats = await container.stats({ stream: false });

      const result: ContainerStats = {};

      // CPU calculation
      if (stats.cpu_stats && stats.precpu_stats) {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || 1;

        if (systemDelta > 0) {
          result.cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
        }
      }

      // Memory
      if (stats.memory_stats) {
        const usedMemory = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
        result.memoryUsedMb = usedMemory / (1024 * 1024);
        result.memoryLimitMb = stats.memory_stats.limit / (1024 * 1024);
      }

      // Network
      if (stats.networks) {
        let rxBytes = 0;
        let txBytes = 0;
        for (const net of Object.values(stats.networks)) {
          rxBytes += (net as { rx_bytes?: number }).rx_bytes || 0;
          txBytes += (net as { tx_bytes?: number }).tx_bytes || 0;
        }
        result.networkRxMb = rxBytes / (1024 * 1024);
        result.networkTxMb = txBytes / (1024 * 1024);
      }

      // Block I/O
      if (stats.blkio_stats?.io_service_bytes_recursive) {
        for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
          if (entry.op === 'Read') {
            result.blockReadMb = entry.value / (1024 * 1024);
          } else if (entry.op === 'Write') {
            result.blockWriteMb = entry.value / (1024 * 1024);
          }
        }
      }

      // Restart count
      result.restartCount = info.RestartCount || 0;

      return result;
    } catch {
      return {};
    }
  }

  async restartContainer(containerName: string): Promise<void> {
    const container = this.docker.getContainer(containerName);
    await container.restart();
  }

  async pullImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }

        // Follow the pull progress until complete
        this.docker.modem.followProgress(stream, (pullErr: Error | null) => {
          if (pullErr) {
            reject(pullErr);
          } else {
            resolve();
          }
        });
      });
    });
  }

  async getContainerLogs(containerName: string, options?: { tail?: number }): Promise<string> {
    const container = this.docker.getContainer(containerName);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: options?.tail || 100,
      timestamps: false,
    });

    // Docker logs may include header bytes for multiplexed streams
    // Convert buffer to string and clean up
    const logString = logs.toString('utf8');

    // Remove Docker stream headers (first 8 bytes of each frame)
    // This is a simplified approach - works for most cases
    return logString.replace(/[\x00-\x07]/g, '').trim();
  }
}

// ==================== SSH Implementation ====================

/**
 * Docker client using SSH commands (wraps existing DockerSSH functionality).
 * Used for managing containers on remote servers.
 */
export class DockerSSHClient implements DockerClient {
  private client: CommandClient;
  private readonly pathPrefix = 'export PATH="/usr/local/bin:/usr/bin:$PATH" && ';

  constructor(client: CommandClient) {
    this.client = client;
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + 'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}"'
    );

    if (code !== 0) {
      throw new Error('Failed to list containers');
    }

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, status, state] = line.split('|');
        return { id, name, image, status, state };
      });
  }

  async getContainerInfo(containerName: string): Promise<ContainerDetails> {
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.Health.Status}}|{{.Config.Image}}|{{json .NetworkSettings.Ports}}' ${containerName} 2>/dev/null || echo "not_found|false|||{}"`
    );

    if (code !== 0 || stdout.includes(CONTAINER_STATUS.NOT_FOUND)) {
      return { state: CONTAINER_STATUS.NOT_FOUND, running: false, ports: [], image: '' };
    }

    const parts = stdout.trim().split('|');
    const state = parts[0] || 'unknown';
    const running = parts[1] === 'true';
    const healthRaw = parts[2];
    const health = healthRaw && healthRaw !== '' && healthRaw !== '<no value>' ? healthRaw : undefined;
    const image = parts[3] || '';
    const portsJson = parts.slice(4).join('|');

    const ports: Array<{ host: number | null; container: number; protocol: string }> = [];
    try {
      const portsData = safeJsonParse(portsJson, {});
      for (const [containerPort, bindings] of Object.entries(portsData)) {
        const [portStr, protocol] = containerPort.split('/');
        const containerPortNum = parseInt(portStr, 10);

        if (Array.isArray(bindings) && bindings.length > 0) {
          for (const binding of bindings as Array<{ HostIp: string; HostPort: string }>) {
            ports.push({
              host: binding.HostPort ? parseInt(binding.HostPort, 10) : null,
              container: containerPortNum,
              protocol: protocol || 'tcp',
            });
          }
        } else {
          ports.push({
            host: null,
            container: containerPortNum,
            protocol: protocol || 'tcp',
          });
        }
      }
    } catch {
      // Parsing failed
    }

    return { state, running, health, ports, image };
  }

  async getContainerHealth(containerName: string): Promise<ContainerHealth> {
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.Health.Status}}' ${containerName} 2>/dev/null || echo "not_found|false|"`
    );

    if (code !== 0 || stdout.includes(CONTAINER_STATUS.NOT_FOUND)) {
      return { state: CONTAINER_STATUS.NOT_FOUND, status: 'Container not found', running: false };
    }

    const [state, running, health] = stdout.trim().split('|');

    return {
      state: state || 'unknown',
      status: state === CONTAINER_STATUS.RUNNING ? 'Running' : `Container is ${state}`,
      health: health && health !== '' && health !== '<no value>' ? health : undefined,
      running: running === 'true',
    };
  }

  async getContainerStats(containerName: string): Promise<ContainerStats> {
    const metrics: ContainerStats = {};

    const statsResult = await this.client.exec(
      `docker stats --no-stream --format '{{json .}}' ${containerName} 2>/dev/null`
    );

    if (statsResult.code === 0 && statsResult.stdout) {
      try {
        const stats = JSON.parse(statsResult.stdout.trim());

        if (stats.CPUPerc) {
          const cpu = parseFloat(stats.CPUPerc.replace('%', ''));
          if (!isNaN(cpu)) metrics.cpuPercent = cpu;
        }

        if (stats.MemUsage) {
          const memMatch = stats.MemUsage.match(/([\d.]+)([KMG]i?B)\s*\/\s*([\d.]+)([KMG]i?B)/i);
          if (memMatch) {
            const [, usedVal, usedUnit, limitVal, limitUnit] = memMatch;
            metrics.memoryUsedMb = this.convertToMb(parseFloat(usedVal), usedUnit);
            metrics.memoryLimitMb = this.convertToMb(parseFloat(limitVal), limitUnit);
          }
        }

        if (stats.NetIO) {
          const netMatch = stats.NetIO.match(/([\d.]+)([KMG]?B)\s*\/\s*([\d.]+)([KMG]?B)/i);
          if (netMatch) {
            const [, rxVal, rxUnit, txVal, txUnit] = netMatch;
            metrics.networkRxMb = this.convertToMb(parseFloat(rxVal), rxUnit);
            metrics.networkTxMb = this.convertToMb(parseFloat(txVal), txUnit);
          }
        }

        if (stats.BlockIO) {
          const blockMatch = stats.BlockIO.match(/([\d.]+)([KMG]?B)\s*\/\s*([\d.]+)([KMG]?B)/i);
          if (blockMatch) {
            const [, readVal, readUnit, writeVal, writeUnit] = blockMatch;
            metrics.blockReadMb = this.convertToMb(parseFloat(readVal), readUnit);
            metrics.blockWriteMb = this.convertToMb(parseFloat(writeVal), writeUnit);
          }
        }
      } catch {
        // JSON parse failed
      }
    }

    // Get restart count
    const inspectResult = await this.client.exec(
      `docker inspect --format '{{.RestartCount}}' ${containerName} 2>/dev/null`
    );
    if (inspectResult.code === 0 && inspectResult.stdout) {
      const restarts = parseInt(inspectResult.stdout.trim());
      if (!isNaN(restarts)) {
        metrics.restartCount = restarts;
      }
    }

    return metrics;
  }

  private convertToMb(value: number, unit: string): number {
    const unitLower = unit.toLowerCase();
    if (unitLower.includes('g')) return value * 1024;
    if (unitLower.includes('k')) return value / 1024;
    if (unitLower.includes('b') && !unitLower.includes('k') && !unitLower.includes('m') && !unitLower.includes('g')) {
      return value / (1024 * 1024);
    }
    return value;
  }

  async restartContainer(containerName: string): Promise<void> {
    const { code, stderr } = await this.client.exec(this.pathPrefix + `docker restart ${containerName}`);
    if (code !== 0) {
      throw new Error(`Failed to restart container: ${stderr}`);
    }
  }

  async pullImage(image: string): Promise<void> {
    const { code, stderr } = await this.client.exec(this.pathPrefix + `docker pull ${image}`);
    if (code !== 0) {
      throw new Error(`Failed to pull image: ${stderr}`);
    }
  }

  async getContainerLogs(containerName: string, options?: { tail?: number }): Promise<string> {
    const args = ['docker logs'];
    if (options?.tail) args.push('--tail', options.tail.toString());
    args.push(containerName);

    const { stdout, stderr, code } = await this.client.exec(this.pathPrefix + args.join(' '));
    if (code !== 0) {
      throw new Error(`Failed to get logs: ${stderr}`);
    }
    return stdout + stderr;
  }
}

// ==================== Factory ====================

export interface DockerClientConfig {
  mode: typeof DOCKER_MODE.SOCKET | typeof DOCKER_MODE.SSH;
  sshClient?: CommandClient;
}

/**
 * Create appropriate Docker client based on configuration.
 */
export function createDockerClient(config: DockerClientConfig): DockerClient {
  if (config.mode === DOCKER_MODE.SOCKET) {
    return new DockerSocketClient();
  }

  if (!config.sshClient) {
    throw new Error('SSH client required for SSH mode');
  }

  return new DockerSSHClient(config.sshClient);
}

// ==================== Server-Based Factory ====================

import { createClientForServer, type GetSSHCredentials, type CommandClient as SSHCommandClient } from './ssh.js';

export interface DockerClientForServerResult {
  dockerClient: DockerClient | null;
  sshClient: SSHCommandClient | null; // SSH client for file operations (compose files, etc.)
  error?: string;
  mode: typeof DOCKER_MODE.SOCKET | typeof DOCKER_MODE.SSH;
  needsConnect: boolean; // Whether sshClient.connect() needs to be called
}

/**
 * Create appropriate Docker client for a server based on its dockerMode setting.
 * Returns both a DockerClient and the underlying SSH client (for file operations).
 *
 * For socket mode: DockerClient uses socket, SSH client may still be needed for file ops
 * For SSH mode: DockerClient uses SSH, same client used for both
 */
export async function createDockerClientForServer(
  server: { hostname: string; dockerMode: string; serverType: string; environmentId: string },
  getCredentials: GetSSHCredentials
): Promise<DockerClientForServerResult> {
  const mode = server.dockerMode as typeof DOCKER_MODE.SOCKET | typeof DOCKER_MODE.SSH;

  if (mode === DOCKER_MODE.SOCKET) {
    // Socket mode - use local Docker socket
    // Still create SSH client for file operations if needed
    const { client: sshClient, error } = await createClientForServer(
      server.hostname,
      server.environmentId,
      getCredentials,
      { serverType: server.serverType }
    );

    return {
      dockerClient: new DockerSocketClient(),
      sshClient,
      error,
      mode: DOCKER_MODE.SOCKET,
      needsConnect: !!sshClient && !error, // SSH client needs connect if available
    };
  }

  // SSH mode - use SSH for everything
  const { client: sshClient, error } = await createClientForServer(
    server.hostname,
    server.environmentId,
    getCredentials,
    { serverType: server.serverType }
  );

  if (!sshClient) {
    return {
      dockerClient: null,
      sshClient: null,
      error: error || 'Failed to create SSH client',
      mode: DOCKER_MODE.SSH,
      needsConnect: false,
    };
  }

  return {
    dockerClient: new DockerSSHClient(sshClient),
    sshClient,
    mode: DOCKER_MODE.SSH,
    needsConnect: true,
  };
}
