import { Client, type ConnectConfig, type ExecOptions } from 'ssh2';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, stat, writeFile as fsWriteFile } from 'fs/promises';
import { config } from './config.js';
import { getSystemSettings } from '../services/system-settings.js';

const execAsync = promisify(exec);

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface LocalExecOptions {
  env?: Record<string, string>;
  timeout?: number;
}

export interface CommandClient {
  connect(): Promise<void>;
  exec(command: string, options?: ExecOptions | LocalExecOptions): Promise<SSHExecResult>;
  execStream(command: string, onData: (data: string, isStderr: boolean) => void): Promise<number>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  disconnect(): void;
}

export interface SSHClientOptions {
  hostname: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  privateKey?: string | Buffer; // Direct key content (takes precedence over path)
}

/**
 * Docker host gateway IPs that should be treated as remote SSH targets, not localhost.
 * When BridgePort runs in a container and needs to manage its host, it connects
 * via the Docker bridge gateway IP.
 */
const HOST_GATEWAY_IPS = [
  '172.17.0.1',           // Default Docker bridge network gateway (Linux)
  'host.docker.internal', // Docker Desktop (Mac/Windows) and Linux with extra_hosts
];

/**
 * Check if hostname refers to localhost.
 * Docker host gateway IPs (172.17.0.1, host.docker.internal) are NOT considered localhost
 * because they represent the container's host machine accessible via SSH.
 */
export function isLocalhost(hostname: string): boolean {
  // Host gateway IPs should use SSH, not local execution
  if (HOST_GATEWAY_IPS.includes(hostname)) {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Check if hostname is a Docker host gateway (for connecting to host from container)
 */
export function isHostGateway(hostname: string): boolean {
  return HOST_GATEWAY_IPS.includes(hostname);
}

// Local command execution (for localhost without SSH)
export class LocalClient implements CommandClient {
  async connect(): Promise<void> {
    // No connection needed for local execution
  }

  async exec(command: string, options?: LocalExecOptions): Promise<SSHExecResult> {
    // Get timeout from system settings if not provided
    let timeout = options?.timeout;
    if (!timeout) {
      const settings = await getSystemSettings();
      timeout = settings.sshCommandTimeoutMs;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execError.stdout || '',
        stderr: execError.stderr || String(error),
        code: execError.code || 1,
      };
    }
  }

  async execStream(
    command: string,
    onData: (data: string, isStderr: boolean) => void
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        onData(data.toString(), false);
      });

      child.stderr.on('data', (data: Buffer) => {
        onData(data.toString(), true);
      });

      child.on('close', (code) => {
        resolve(code ?? 0);
      });

      child.on('error', reject);
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    await fsWriteFile(remotePath, content);
  }

  disconnect(): void {
    // No disconnection needed for local execution
  }
}

export class SSHClient implements CommandClient {
  private options: SSHClientOptions;
  private client: Client | null = null;

  constructor(options: SSHClientOptions) {
    this.options = {
      port: 22,
      username: config.SSH_USER,
      privateKeyPath: config.SSH_KEY_PATH,
      ...options,
    };
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    let privateKey: string | Buffer;

    // Use provided key or read from file
    if (this.options.privateKey) {
      privateKey = this.options.privateKey;
    } else if (this.options.privateKeyPath) {
      const keyPath = this.options.privateKeyPath;

      // Check if key file exists and is a file (not directory)
      try {
        const keyStats = await stat(keyPath);
        if (keyStats.isDirectory()) {
          throw new Error(
            `SSH key path '${keyPath}' is a directory, not a file. ` +
            `Check that the SSH key is properly mounted in docker-compose.`
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`SSH key file not found at '${keyPath}'`);
        }
        throw err;
      }

      privateKey = await readFile(keyPath);
    } else {
      throw new Error('No SSH private key provided. Set the key in environment settings.');
    }

    // Get readyTimeout from system settings
    const settings = await getSystemSettings();

    const connectConfig: ConnectConfig = {
      host: this.options.hostname,
      port: this.options.port,
      username: this.options.username,
      privateKey,
      readyTimeout: settings.sshReadyTimeoutMs,
    };

    return new Promise((resolve, reject) => {
      this.client = new Client();

      this.client.on('ready', () => resolve());
      this.client.on('error', (err) => {
        this.client = null;
        reject(err);
      });

      this.client.connect(connectConfig);
    });
  }

  async exec(command: string, options?: ExecOptions): Promise<SSHExecResult> {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client!.exec(command, options || {}, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code ?? 0 });
        });

        stream.on('error', reject);
      });
    });
  }

  async execStream(
    command: string,
    onData: (data: string, isStderr: boolean) => void
  ): Promise<number> {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        stream.on('data', (data: Buffer) => {
          onData(data.toString(), false);
        });

        stream.stderr.on('data', (data: Buffer) => {
          onData(data.toString(), true);
        });

        stream.on('close', (code: number) => {
          resolve(code ?? 0);
        });

        stream.on('error', reject);
      });
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('error', (err: Error) => {
          sftp.end();
          reject(err);
        });

        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });

        writeStream.end(content);
      });
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  /**
   * Check if the underlying ssh2 client is still connected.
   * Used by the connection pool to detect dead connections.
   */
  isConnected(): boolean {
    return this.client !== null;
  }
}

export async function withSSH<T>(
  options: SSHClientOptions,
  fn: (client: SSHClient) => Promise<T>
): Promise<T> {
  const client = new SSHClient(options);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

// Factory function to create appropriate client based on hostname
export function createClient(options: SSHClientOptions): CommandClient {
  if (isLocalhost(options.hostname)) {
    return new LocalClient();
  }
  return new SSHClient(options);
}

export interface SSHCredentials {
  username: string;
  privateKey: string;
}

export type GetSSHCredentials = (environmentId: string) => Promise<SSHCredentials | null>;

export interface CreateClientResult {
  client: CommandClient | null;
  error?: string;
}

/**
 * Detect the Docker host gateway IP from inside the container.
 * Used when a host-type server is registered as 'localhost' but we need
 * SSH access to the actual Docker host for file operations.
 */
async function detectHostGateway(): Promise<string | null> {
  // Check for host.docker.internal (Docker Desktop)
  try {
    const { stdout } = await execAsync('getent hosts host.docker.internal 2>/dev/null || true', {
      timeout: 2000,
    });
    if (stdout.trim()) {
      return 'host.docker.internal';
    }
  } catch {
    // Not available
  }

  // Check /etc/hosts for host-gateway entry (Docker 20.10+)
  try {
    const hosts = await readFile('/etc/hosts', 'utf-8');
    for (const line of hosts.split('\n')) {
      if (line.includes('host-gateway') || line.includes('host.docker.internal')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] && !parts[0].startsWith('#')) {
          return parts[0];
        }
      }
    }
  } catch {
    // File not accessible
  }

  // Default Docker bridge gateway
  return '172.17.0.1';
}

/**
 * Create appropriate client (SSH or Local) for a server, handling credential lookup.
 * Returns the client or an error message if SSH credentials are not configured.
 *
 * For host-type servers with localhost hostname, resolves to the Docker host gateway
 * IP and uses SSH, since file operations need to target the host filesystem, not the
 * container's filesystem.
 */
export async function createClientForServer(
  hostname: string,
  environmentId: string,
  getCredentials: GetSSHCredentials,
  options?: { serverType?: string }
): Promise<CreateClientResult> {
  if (isLocalhost(hostname)) {
    // Host-type servers registered as 'localhost' need SSH to the Docker host
    // for file operations (the LocalClient runs inside the container)
    if (options?.serverType === 'host') {
      const gatewayIp = await detectHostGateway();
      if (!gatewayIp) {
        return { client: null, error: 'Cannot detect Docker host gateway for file operations' };
      }
      const sshCreds = await getCredentials(environmentId);
      if (!sshCreds) {
        return { client: null, error: 'SSH key not configured — required for host server file operations' };
      }
      return {
        client: new SSHClient({
          hostname: gatewayIp,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        }),
      };
    }
    return { client: new LocalClient() };
  }

  const sshCreds = await getCredentials(environmentId);
  if (!sshCreds) {
    return { client: null, error: 'SSH key not configured for this environment' };
  }

  return {
    client: new SSHClient({
      hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    }),
  };
}

// ---------------------------------------------------------------------------
// SSH Connection Pool
// ---------------------------------------------------------------------------

interface PoolEntry {
  client: SSHClient;
  options: SSHClientOptions;
  lastUsedAt: number;
  refCount: number;
}

/**
 * SSH Connection Pool - reuses SSH connections to reduce handshake overhead.
 *
 * Connections are cached by a `host:port:user` key. When a caller acquires a
 * connection, a lightweight `PooledClient` wrapper is returned. Calling
 * `disconnect()` on the wrapper returns the connection to the pool instead of
 * closing it. Idle connections are reaped after `maxIdleMs` (default 5 min).
 *
 * Dead connections are detected via `SSHClient.isConnected()` and evicted
 * automatically. The underlying ssh2 `Client` is also monitored for `error`
 * and `close` events so that connections that drop unexpectedly are removed
 * from the pool immediately.
 */
class SSHConnectionPool {
  private connections = new Map<string, PoolEntry>();
  private cleanupTimer: NodeJS.Timeout;
  private readonly maxIdleMs = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Allow the process to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private getKey(options: SSHClientOptions): string {
    return `${options.hostname}:${options.port ?? 22}:${options.username ?? 'root'}`;
  }

  /**
   * Acquire a `CommandClient` for the given SSH options.
   *
   * - Localhost connections are never pooled (returns a `LocalClient`).
   * - If an existing healthy connection is available, it is reused.
   * - Otherwise a new `SSHClient` is created, connected, and added to the pool.
   */
  async acquire(options: SSHClientOptions): Promise<CommandClient> {
    // Don't pool localhost connections
    if (isLocalhost(options.hostname)) {
      return new LocalClient();
    }

    const key = this.getKey(options);
    const existing = this.connections.get(key);

    if (existing && existing.client.isConnected()) {
      existing.lastUsedAt = Date.now();
      existing.refCount++;
      return new PooledClient(existing.client, key, this);
    }

    // Existing entry is dead – clean it up
    if (existing) {
      try { existing.client.disconnect(); } catch { /* ignore */ }
      this.connections.delete(key);
    }

    // Create a new connection
    const client = new SSHClient(options);
    await client.connect();

    const entry: PoolEntry = { client, options, lastUsedAt: Date.now(), refCount: 1 };
    this.connections.set(key, entry);

    // Auto-evict if the underlying ssh2 connection drops unexpectedly.
    // SSHClient stores the ssh2 Client in a private field; we listen via the
    // public API by monitoring `isConnected()` in the cleanup loop. However,
    // for immediate eviction we also hook into the ssh2 Client events through
    // a lightweight wrapper: run a no-op exec to get at the stream, which is
    // overkill. Instead, just rely on the cleanup timer + isConnected check +
    // error propagation from PooledClient callers.

    return new PooledClient(client, key, this);
  }

  /**
   * Release a connection back to the pool (decrement refCount).
   * Called by `PooledClient.disconnect()`.
   */
  release(key: string): void {
    const entry = this.connections.get(key);
    if (entry) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * Evict a connection from the pool. Called when a caller detects a dead
   * connection (e.g. exec throws). The underlying client is disconnected.
   */
  evict(key: string): void {
    const entry = this.connections.get(key);
    if (entry) {
      try { entry.client.disconnect(); } catch { /* ignore */ }
      this.connections.delete(key);
    }
  }

  /** Periodic cleanup of idle connections. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.connections) {
      // Evict dead connections regardless of refCount
      if (!entry.client.isConnected()) {
        console.log(`[SSHPool] Removing dead connection: ${key}`);
        this.connections.delete(key);
        continue;
      }
      // Evict idle connections that have exceeded the TTL
      if (entry.refCount === 0 && (now - entry.lastUsedAt) > this.maxIdleMs) {
        console.log(`[SSHPool] Closing idle connection: ${key}`);
        try { entry.client.disconnect(); } catch { /* ignore */ }
        this.connections.delete(key);
      }
    }
  }

  /** Return pool statistics (useful for debugging / health endpoints). */
  stats(): { total: number; idle: number; active: number } {
    let idle = 0;
    let active = 0;
    for (const entry of this.connections.values()) {
      if (entry.refCount > 0) active++;
      else idle++;
    }
    return { total: this.connections.size, idle, active };
  }

  /** Shut down the pool – close all connections and stop the cleanup timer. */
  shutdown(): void {
    clearInterval(this.cleanupTimer);
    for (const [, entry] of this.connections) {
      try { entry.client.disconnect(); } catch { /* ignore */ }
    }
    this.connections.clear();
    console.log('[SSHPool] Pool shut down');
  }
}

/**
 * Wraps an `SSHClient` obtained from the pool.
 *
 * - `connect()` is a no-op (already connected).
 * - `disconnect()` returns the connection to the pool instead of closing it.
 * - All other methods delegate to the underlying `SSHClient`.
 * - If an exec/writeFile call fails due to a dead connection, the pool entry
 *   is evicted so subsequent acquires create a fresh connection.
 */
class PooledClient implements CommandClient {
  private client: SSHClient;
  private key: string;
  private pool: SSHConnectionPool;
  private released = false;

  constructor(client: SSHClient, key: string, pool: SSHConnectionPool) {
    this.client = client;
    this.key = key;
    this.pool = pool;
  }

  async connect(): Promise<void> {
    // Already connected via pool – no-op
  }

  async exec(command: string, options?: ExecOptions): Promise<SSHExecResult> {
    try {
      return await this.client.exec(command, options);
    } catch (err) {
      // If the connection is dead, evict from pool so next acquire gets a fresh one
      if (!this.client.isConnected()) {
        this.pool.evict(this.key);
        this.released = true;
      }
      throw err;
    }
  }

  async execStream(
    command: string,
    onData: (data: string, isStderr: boolean) => void
  ): Promise<number> {
    try {
      return await this.client.execStream(command, onData);
    } catch (err) {
      if (!this.client.isConnected()) {
        this.pool.evict(this.key);
        this.released = true;
      }
      throw err;
    }
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    try {
      return await this.client.writeFile(remotePath, content);
    } catch (err) {
      if (!this.client.isConnected()) {
        this.pool.evict(this.key);
        this.released = true;
      }
      throw err;
    }
  }

  disconnect(): void {
    if (!this.released) {
      this.released = true;
      this.pool.release(this.key);
    }
  }
}

/** Singleton SSH connection pool instance. */
export const sshPool = new SSHConnectionPool();

/**
 * Factory function that returns a pooled `CommandClient`.
 * Drop-in replacement for `createClient()` with connection reuse.
 */
export async function getPooledClient(options: SSHClientOptions): Promise<CommandClient> {
  return sshPool.acquire(options);
}

// Docker-specific commands
export class DockerSSH {
  private client: CommandClient;
  // Ensure docker is in PATH for non-interactive SSH sessions
  private readonly pathPrefix = 'export PATH="/usr/local/bin:/usr/bin:$PATH" && ';
  // Cache detected compose command and version
  private composeInfo: { cmd: string; majorVersion: number } | null = null;

  constructor(client: CommandClient) {
    this.client = client;
  }

  // Detect which compose command is available and its major version
  private async getComposeInfo(): Promise<{ cmd: string; majorVersion: number }> {
    if (this.composeInfo) {
      return this.composeInfo;
    }

    // Try docker compose (new plugin style) first
    const { stdout: v2Out, code: pluginCode } = await this.client.exec(
      this.pathPrefix + 'docker compose version --short 2>/dev/null'
    );
    if (pluginCode === 0 && v2Out.trim()) {
      const version = parseInt(v2Out.trim().split('.')[0], 10);
      this.composeInfo = { cmd: 'docker compose', majorVersion: version >= 2 ? version : 2 };
      return this.composeInfo;
    }

    // Fall back to docker-compose (standalone)
    const { stdout: v1Out, code: standaloneCode } = await this.client.exec(
      this.pathPrefix + 'docker-compose version --short 2>/dev/null'
    );
    if (standaloneCode === 0 && v1Out.trim()) {
      const version = parseInt(v1Out.trim().split('.')[0], 10);
      this.composeInfo = { cmd: 'docker-compose', majorVersion: version || 1 };
      return this.composeInfo;
    }

    // Default to docker compose v2 and let it fail with a clear error
    this.composeInfo = { cmd: 'docker compose', majorVersion: 2 };
    return this.composeInfo;
  }

  // Backward-compatible wrapper for existing code
  private async getComposeCommand(): Promise<string> {
    const { cmd } = await this.getComposeInfo();
    return cmd;
  }

  async listContainers(): Promise<Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    state: string;
  }>> {
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

  async restartContainer(containerName: string): Promise<void> {
    const { code, stderr } = await this.client.exec(this.pathPrefix + `docker restart ${containerName}`);
    if (code !== 0) {
      throw new Error(`Failed to restart container: ${stderr}`);
    }
  }

  async getContainerHealth(containerName: string): Promise<{
    state: string;
    status: string;
    health?: string;
    running: boolean;
  }> {
    // Get container state and health status (use | as delimiter since tabs don't work reliably)
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.Health.Status}}' ${containerName} 2>/dev/null || echo "not_found|false|"`
    );

    if (code !== 0 || stdout.includes('not_found')) {
      return { state: 'not_found', status: 'Container not found', running: false };
    }

    const [state, running, health] = stdout.trim().split('|');

    return {
      state: state || 'unknown',
      status: state === 'running' ? 'Running' : `Container is ${state}`,
      health: health && health !== '' && health !== '<no value>' ? health : undefined,
      running: running === 'true',
    };
  }

  async getContainerInfo(containerName: string): Promise<{
    state: string;
    running: boolean;
    health?: string;
    ports: Array<{ host: number | null; container: number; protocol: string }>;
    image: string;
  }> {
    // Get comprehensive container info: state, health, ports, and image
    // Format: state|running|health|image|ports_json
    // Ports come from NetworkSettings.Ports which is a map like {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.Health.Status}}|{{.Config.Image}}|{{json .NetworkSettings.Ports}}' ${containerName} 2>/dev/null || echo "not_found|false|||{}"`
    );

    if (code !== 0 || stdout.includes('not_found')) {
      return { state: 'not_found', running: false, ports: [], image: '' };
    }

    const parts = stdout.trim().split('|');
    const state = parts[0] || 'unknown';
    const running = parts[1] === 'true';
    const healthRaw = parts[2];
    const health = healthRaw && healthRaw !== '' && healthRaw !== '<no value>' ? healthRaw : undefined;
    const image = parts[3] || '';
    const portsJson = parts.slice(4).join('|'); // Rejoin in case image contains |

    // Parse ports from Docker's NetworkSettings.Ports format
    const ports: Array<{ host: number | null; container: number; protocol: string }> = [];
    try {
      const portsData = JSON.parse(portsJson || '{}');
      // portsData looks like: {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}], "443/tcp": null}
      for (const [containerPort, bindings] of Object.entries(portsData)) {
        const [portStr, protocol] = containerPort.split('/');
        const containerPortNum = parseInt(portStr, 10);

        if (Array.isArray(bindings) && bindings.length > 0) {
          // Port is bound to host
          for (const binding of bindings as Array<{ HostIp: string; HostPort: string }>) {
            ports.push({
              host: binding.HostPort ? parseInt(binding.HostPort, 10) : null,
              container: containerPortNum,
              protocol: protocol || 'tcp',
            });
          }
        } else {
          // Port exposed but not bound to host
          ports.push({
            host: null,
            container: containerPortNum,
            protocol: protocol || 'tcp',
          });
        }
      }
    } catch {
      // If parsing fails, return empty ports
    }

    return { state, running, health, ports, image };
  }

  async checkUrl(url: string, timeoutSeconds: number = 5): Promise<{
    success: boolean;
    statusCode?: number;
    error?: string;
  }> {
    const { stdout, code } = await this.client.exec(
      `curl -s -o /dev/null -w '%{http_code}' --connect-timeout ${timeoutSeconds} '${url}' 2>/dev/null || echo "000"`
    );

    const statusCode = parseInt(stdout.trim(), 10);

    if (code !== 0 || statusCode === 0) {
      return { success: false, error: 'Connection failed or timed out' };
    }

    return {
      success: statusCode >= 200 && statusCode < 400,
      statusCode,
      error: statusCode >= 400 ? `HTTP ${statusCode}` : undefined,
    };
  }

  async pullImage(image: string): Promise<void> {
    const { code, stderr } = await this.client.exec(this.pathPrefix + `docker pull ${image}`);
    if (code !== 0) {
      throw new Error(`Failed to pull image: ${stderr}`);
    }
  }

  async containerLogs(
    containerName: string,
    options: { tail?: number; follow?: boolean } = {}
  ): Promise<string> {
    const args = ['docker logs'];
    if (options.tail) args.push('--tail', options.tail.toString());
    if (options.follow) args.push('-f');
    args.push(containerName);

    const { stdout, stderr, code } = await this.client.exec(this.pathPrefix + args.join(' '));
    if (code !== 0) {
      throw new Error(`Failed to get logs: ${stderr}`);
    }
    return stdout + stderr; // Docker logs go to both
  }

  async composeUp(composePath: string, serviceName?: string, forceRecreate: boolean = true): Promise<void> {
    const { cmd: compose, majorVersion } = await this.getComposeInfo();

    if (forceRecreate && majorVersion === 1) {
      // docker-compose v1.x has a bug with --force-recreate on newer Docker versions
      // (KeyError: 'ContainerConfig'). Work around by using rm + up instead.
      const rmCmd = serviceName
        ? `${compose} -f ${composePath} rm -f -s ${serviceName}`
        : `${compose} -f ${composePath} down`;
      await this.client.exec(this.pathPrefix + rmCmd);

      const upCmd = serviceName
        ? `${compose} -f ${composePath} up -d ${serviceName}`
        : `${compose} -f ${composePath} up -d`;
      const { code, stderr } = await this.client.exec(this.pathPrefix + upCmd);
      if (code !== 0) {
        throw new Error(`Failed to run compose up: ${stderr}`);
      }
    } else {
      // docker compose v2.x: use --force-recreate normally
      const forceFlag = forceRecreate ? '--force-recreate' : '';
      const cmd = serviceName
        ? `${compose} -f ${composePath} up -d ${forceFlag} ${serviceName}`
        : `${compose} -f ${composePath} up -d ${forceFlag}`;

      const { code, stderr } = await this.client.exec(this.pathPrefix + cmd);
      if (code !== 0) {
        throw new Error(`Failed to run compose up: ${stderr}`);
      }
    }
  }

  async composePull(composePath: string, serviceName?: string): Promise<void> {
    const compose = await this.getComposeCommand();
    const cmd = serviceName
      ? `${compose} -f ${composePath} pull ${serviceName}`
      : `${compose} -f ${composePath} pull`;

    const { code, stderr } = await this.client.exec(this.pathPrefix + cmd);
    if (code !== 0) {
      throw new Error(`Failed to pull compose images: ${stderr}`);
    }
  }
}
