import Docker from 'dockerode';
import { access, constants } from 'fs/promises';
import { shellEscape, type CommandClient } from './ssh.js';
import { CONTAINER_STATUS, DOCKER_MODE } from './constants.js';
import { safeJsonParse } from './helpers.js';

// ==================== Helpers ====================

/**
 * Parse Docker's `.Config.Env` array (`["KEY=value", ...]`) into a key→value
 * map. The first `=` splits each entry, so values may themselves contain `=`.
 * Malformed entries without a `=` are ignored.
 */
function parseEnvArray(env: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return result;
}

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
  ports: Array<{ host: number | null; container: number; protocol: string; hostIp?: string | null }>;
  image: string;
}

export interface ContainerHealth {
  state: string;
  status: string;
  health?: string;
  running: boolean;
}

/**
 * Read-only image-digest view of a running container, used by drift detection.
 *
 * `imageRef` is the human-readable image reference the container was created
 * from (e.g. `nginx:1.25`). `repoDigests` are the `repo@sha256:...` entries
 * Docker records for the resolved local image — present only when the image was
 * pulled from a registry (locally-built images have none). `configDigest` is the
 * image's config digest (`Image` field, the local image ID); it is stable across
 * registries but is NOT the registry manifest digest.
 *
 * `found` is false when the container does not exist on the host.
 */
export interface ContainerImageDigests {
  found: boolean;
  imageRef: string;
  repoDigests: string[];
  configDigest: string;
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
 * Auth credentials for a private registry pull. Mirrors dockerode's authconfig shape.
 * For socket-mode pulls, these are passed in-process per call; for SSH-mode, auth
 * persists on the remote server's ~/.docker/config.json via `docker login`.
 */
export interface RegistryAuthConfig {
  username: string;
  password: string;
  serveraddress: string; // registry host, e.g. "registry.digitalocean.com"
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
  /**
   * Read-only: the container's effective env (`.Config.Env`) as a key→value map.
   * Includes image-baked and Docker-injected vars (PATH, HOSTNAME, …) — callers
   * that only care about BRIDGEPORT-managed keys must filter. Returns `null` when
   * the container does not exist.
   */
  getContainerEnv(containerName: string): Promise<Record<string, string> | null>;
  /** Read-only: image digests of the container's current image (drift). */
  getContainerImageDigests(containerName: string): Promise<ContainerImageDigests>;
  restartContainer(containerName: string): Promise<void>;
  pullImage(image: string, auth?: RegistryAuthConfig): Promise<void>;
  getContainerLogs(
    containerName: string,
    options?: { tail?: number; until?: string; timestamps?: boolean }
  ): Promise<string>;
  pruneImages(mode: 'dangling' | 'all'): Promise<{ spaceReclaimedBytes: number }>;
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
      const ports: Array<{ host: number | null; container: number; protocol: string; hostIp?: string | null }> = [];
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
              hostIp: binding.HostIp || null,
            });
          }
        } else {
          ports.push({
            host: null,
            container: containerPortNum,
            protocol: protocol || 'tcp',
            hostIp: null,
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

  async getContainerEnv(containerName: string): Promise<Record<string, string> | null> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      return parseEnvArray(info.Config?.Env ?? []);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getContainerImageDigests(containerName: string): Promise<ContainerImageDigests> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      // Resolve the local image the container currently runs to read its
      // RepoDigests (registry-pull provenance). info.Image is the image ID.
      let repoDigests: string[] = [];
      try {
        const image = this.docker.getImage(info.Image);
        const imageInfo = await image.inspect();
        repoDigests = Array.isArray(imageInfo.RepoDigests) ? imageInfo.RepoDigests : [];
      } catch {
        // Image inspect can fail if the image was removed out from under the
        // running container; fall back to no repo digests.
      }
      return {
        found: true,
        imageRef: info.Config?.Image || '',
        repoDigests,
        configDigest: info.Image || '',
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { found: false, imageRef: '', repoDigests: [], configDigest: '' };
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

  async pullImage(image: string, auth?: RegistryAuthConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const callback = (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        if (!stream) {
          reject(new Error('docker pull returned no stream'));
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
      };

      if (auth) {
        this.docker.pull(image, { authconfig: auth }, callback);
      } else {
        this.docker.pull(image, callback);
      }
    });
  }

  async getContainerLogs(
    containerName: string,
    options?: { tail?: number; until?: string; timestamps?: boolean }
  ): Promise<string> {
    const container = this.docker.getContainer(containerName);

    // dockerode accepts `until` as a Unix timestamp (seconds). Convert from ISO
    // if provided. Preserve sub-second precision (Docker Engine API accepts a
    // fractional value) so pagination cursors like ".500Z" don't get floored
    // and cause partial overlap with the rendered page.
    let untilTs: number | undefined;
    if (options?.until) {
      const parsed = new Date(options.until).getTime() / 1000;
      if (!Number.isNaN(parsed)) untilTs = parsed;
    }

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: options?.tail || 100,
      timestamps: options?.timestamps ?? false,
      ...(untilTs !== undefined ? { until: untilTs } : {}),
    });

    // Docker logs may include header bytes for multiplexed streams
    // Convert buffer to string and clean up
    const logString = logs.toString('utf8');

    // Remove Docker stream headers (first 8 bytes of each frame)
    // This is a simplified approach - works for most cases
    return logString.replace(/[\x00-\x07]/g, '').trim();
  }

  async pruneImages(mode: 'dangling' | 'all'): Promise<{ spaceReclaimedBytes: number }> {
    // For "all" mode, include non-dangling images (dangling: false means "not dangling only")
    const filters = mode === 'all' ? { dangling: ['false'] } : {};
    const result = await this.docker.pruneImages({ filters: JSON.stringify(filters) });
    return { spaceReclaimedBytes: (result as { SpaceReclaimed?: number }).SpaceReclaimed ?? 0 };
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

    const ports: Array<{ host: number | null; container: number; protocol: string; hostIp?: string | null }> = [];
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
              hostIp: binding.HostIp || null,
            });
          }
        } else {
          ports.push({
            host: null,
            container: containerPortNum,
            protocol: protocol || 'tcp',
            hostIp: null,
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

  async getContainerEnv(containerName: string): Promise<Record<string, string> | null> {
    // shellEscape() the container name — it originates from user-supplied
    // ServiceDeployment.containerName. Read-only inspect, never mutates state.
    const { stdout, code } = await this.client.exec(
      this.pathPrefix +
        `docker inspect --format '{{json .Config.Env}}' ${shellEscape(containerName)} 2>/dev/null || echo "__not_found__"`
    );
    const trimmed = stdout.trim();
    if (code !== 0 || trimmed === '__not_found__' || trimmed === '') {
      return null;
    }
    const arr = safeJsonParse<string[]>(trimmed, []);
    return parseEnvArray(Array.isArray(arr) ? arr : []);
  }

  async getContainerImageDigests(containerName: string): Promise<ContainerImageDigests> {
    // First inspect the container for its image reference + local image ID.
    const { stdout, code } = await this.client.exec(
      this.pathPrefix +
        `docker inspect --format '{{.Config.Image}}|{{.Image}}' ${shellEscape(containerName)} 2>/dev/null || echo "__not_found__"`
    );
    const trimmed = stdout.trim();
    if (code !== 0 || trimmed === '__not_found__' || trimmed === '') {
      return { found: false, imageRef: '', repoDigests: [], configDigest: '' };
    }
    const sep = trimmed.indexOf('|');
    const imageRef = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const configDigest = sep === -1 ? '' : trimmed.slice(sep + 1);

    // Read RepoDigests of the resolved local image (registry-pull provenance).
    // Failure here is non-fatal — fall back to an empty list.
    let repoDigests: string[] = [];
    if (configDigest) {
      const digestResult = await this.client.exec(
        this.pathPrefix +
          `docker inspect --format '{{json .RepoDigests}}' ${shellEscape(configDigest)} 2>/dev/null || echo "[]"`
      );
      if (digestResult.code === 0) {
        const arr = safeJsonParse<string[]>(digestResult.stdout.trim() || '[]', []);
        if (Array.isArray(arr)) repoDigests = arr;
      }
    }

    return { found: true, imageRef, repoDigests, configDigest };
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

  async pullImage(image: string, _auth?: RegistryAuthConfig): Promise<void> {
    // SSH-mode pulls rely on the persistent `docker login` performed by
    // ensureRegistryLogin (see src/services/registry-login.ts). The auth arg
    // is accepted for interface parity with the socket client but unused here.
    const { code, stderr } = await this.client.exec(this.pathPrefix + `docker pull ${image}`);
    if (code !== 0) {
      throw new Error(`Failed to pull image: ${stderr}`);
    }
  }

  async getContainerLogs(
    containerName: string,
    options?: { tail?: number; until?: string; timestamps?: boolean }
  ): Promise<string> {
    const args = ['docker logs'];
    if (options?.tail) args.push('--tail', options.tail.toString());
    if (options?.timestamps) args.push('-t');
    if (options?.until) args.push('--until', shellEscape(options.until));
    args.push(shellEscape(containerName));

    const { stdout, stderr, code } = await this.client.exec(this.pathPrefix + args.join(' '));
    if (code !== 0) {
      throw new Error(`Failed to get logs: ${stderr}`);
    }
    return stdout + stderr;
  }

  async pruneImages(mode: 'dangling' | 'all'): Promise<{ spaceReclaimedBytes: number }> {
    const cmd = mode === 'all' ? 'docker image prune -af' : 'docker image prune -f';
    const { stdout, code, stderr } = await this.client.exec(this.pathPrefix + cmd);
    if (code !== 0) {
      throw new Error(`Failed to prune images: ${stderr}`);
    }
    // Parse "Total reclaimed space: 1.23GB" from docker output
    const match = stdout.match(/Total reclaimed space:\s*([\d.]+)\s*([KMGT]?B)/i);
    const spaceReclaimedBytes = match ? this.parseSizeToBytes(match[1], match[2]) : 0;
    return { spaceReclaimedBytes };
  }

  private parseSizeToBytes(value: string, unit: string): number {
    const num = parseFloat(value);
    const u = unit.toUpperCase();
    if (u === 'TB') return num * 1024 ** 4;
    if (u === 'GB') return num * 1024 ** 3;
    if (u === 'MB') return num * 1024 ** 2;
    if (u === 'KB') return num * 1024;
    return num;
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
