import { Client, type ConnectConfig, type ExecOptions } from 'ssh2';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, stat } from 'fs/promises';
import { config } from './config.js';

const execAsync = promisify(exec);

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandClient {
  connect(): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<SSHExecResult>;
  execStream(command: string, onData: (data: string, isStderr: boolean) => void): Promise<number>;
  disconnect(): void;
}

export interface SSHClientOptions {
  hostname: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  privateKey?: string | Buffer; // Direct key content (takes precedence over path)
}

// Check if hostname refers to localhost
export function isLocalhost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// Local command execution (for localhost without SSH)
export class LocalClient implements CommandClient {
  async connect(): Promise<void> {
    // No connection needed for local execution
  }

  async exec(command: string): Promise<SSHExecResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 60000, // 60 second timeout
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

    const connectConfig: ConnectConfig = {
      host: this.options.hostname,
      port: this.options.port,
      username: this.options.username,
      privateKey,
      readyTimeout: 10000,
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

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
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

// Docker-specific commands
export class DockerSSH {
  private client: CommandClient;
  // Ensure docker is in PATH for non-interactive SSH sessions
  private readonly pathPrefix = 'export PATH="/usr/local/bin:/usr/bin:$PATH" && ';

  constructor(client: CommandClient) {
    this.client = client;
  }

  async listContainers(): Promise<Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    state: string;
  }>> {
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + 'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}"'
    );

    if (code !== 0) {
      throw new Error('Failed to list containers');
    }

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, status, state] = line.split('\t');
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
    // Get container state and health status
    const { stdout, code } = await this.client.exec(
      this.pathPrefix + `docker inspect --format '{{.State.Status}}\\t{{.State.Running}}\\t{{.State.Health.Status}}' ${containerName} 2>/dev/null || echo "not_found\\tfalse\\t"`
    );

    if (code !== 0 || stdout.includes('not_found')) {
      return { state: 'not_found', status: 'Container not found', running: false };
    }

    const [state, running, health] = stdout.trim().split('\t');

    return {
      state: state || 'unknown',
      status: state === 'running' ? 'Running' : `Container is ${state}`,
      health: health && health !== '' ? health : undefined,
      running: running === 'true',
    };
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

  async composeUp(composePath: string, serviceName?: string): Promise<void> {
    const cmd = serviceName
      ? `docker compose -f ${composePath} up -d ${serviceName}`
      : `docker compose -f ${composePath} up -d`;

    const { code, stderr } = await this.client.exec(this.pathPrefix + cmd);
    if (code !== 0) {
      throw new Error(`Failed to run compose up: ${stderr}`);
    }
  }

  async composePull(composePath: string, serviceName?: string): Promise<void> {
    const cmd = serviceName
      ? `docker compose -f ${composePath} pull ${serviceName}`
      : `docker compose -f ${composePath} pull`;

    const { code, stderr } = await this.client.exec(cmd);
    if (code !== 0) {
      throw new Error(`Failed to pull compose images: ${stderr}`);
    }
  }
}
