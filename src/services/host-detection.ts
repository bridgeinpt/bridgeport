import { readFile } from 'fs/promises';
import { SSHClient } from '../lib/ssh.js';
import { prisma } from '../lib/db.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { isDockerSocketAvailable } from '../lib/docker.js';

/**
 * Known Docker gateway IPs that indicate "connect to host from inside container"
 * These IPs should be treated as SSH targets, not as localhost
 */
export const HOST_GATEWAY_IPS = [
  '172.17.0.1',     // Default Docker bridge network gateway (Linux)
  'host.docker.internal', // Docker Desktop (Mac/Windows) and Linux with extra_hosts
];

export interface HostInfo {
  detected: boolean;
  gatewayIp: string | null;
  sshReachable: boolean;
  sshError?: string;
  registered: boolean;
  registeredGlobally: boolean; // true if host is registered in ANY environment
  registeredEnvironment?: string; // name of environment where host is registered
  serverId?: string;
  serverName?: string;
}

/**
 * Check if a hostname is a Docker host gateway (container trying to reach host)
 */
export function isHostGateway(hostname: string): boolean {
  return HOST_GATEWAY_IPS.includes(hostname);
}

/**
 * Detect the Docker host gateway IP from inside the container
 * Tries multiple methods in order of reliability
 */
export async function detectHostGateway(): Promise<string | null> {
  // Method 1: Check for host.docker.internal (Docker Desktop)
  try {
    const { execSync } = await import('child_process');
    // Try to resolve host.docker.internal
    const result = execSync('getent hosts host.docker.internal 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.trim()) {
      return 'host.docker.internal';
    }
  } catch {
    // Ignore - not available
  }

  // Method 2: Check /etc/hosts for host-gateway entry (Docker 20.10+)
  try {
    const hosts = await readFile('/etc/hosts', 'utf-8');
    const lines = hosts.split('\n');
    for (const line of lines) {
      if (line.includes('host-gateway') || line.includes('host.docker.internal')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] && !parts[0].startsWith('#')) {
          return parts[0];
        }
      }
    }
  } catch {
    // Ignore - file not accessible
  }

  // Method 3: Default Docker bridge gateway (Linux)
  // The default docker0 bridge uses 172.17.0.1 as the gateway
  try {
    const { execSync } = await import('child_process');
    // Get default gateway from routing table
    const result = execSync('ip route show default 2>/dev/null | awk \'{print $3}\' | head -1', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const gateway = result.trim();
    if (gateway && gateway.startsWith('172.17.')) {
      return gateway;
    }
  } catch {
    // Ignore - ip command not available
  }

  // Method 4: Fallback to standard Docker bridge IP
  return '172.17.0.1';
}

/**
 * Test SSH connectivity to a host
 */
async function testSshConnectivity(
  hostname: string,
  username: string,
  privateKey: string
): Promise<{ success: boolean; error?: string }> {
  const client = new SSHClient({
    hostname,
    username,
    privateKey,
  });

  try {
    await client.connect();
    // Run a simple command to verify connectivity
    const result = await client.exec('echo "ok"');
    client.disconnect();

    if (result.code === 0 && result.stdout.trim() === 'ok') {
      return { success: true };
    }
    return { success: false, error: 'Command execution failed' };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Get comprehensive host detection info for an environment
 * Checks if host is detectable, SSH reachable, and already registered
 */
export async function getHostInfo(environmentId: string): Promise<HostInfo> {
  // Detect gateway IP
  const gatewayIp = await detectHostGateway();

  if (!gatewayIp) {
    return {
      detected: false,
      gatewayIp: null,
      sshReachable: false,
      registered: false,
      registeredGlobally: false,
    };
  }

  // Check if host server already registered in this environment
  const existingServer = await prisma.server.findFirst({
    where: {
      environmentId,
      serverType: 'host',
    },
    select: {
      id: true,
      name: true,
      hostname: true,
    },
  });

  // Check if host server registered in ANY environment (global check)
  const globalServer = existingServer ? null : await prisma.server.findFirst({
    where: {
      serverType: 'host',
    },
    select: {
      id: true,
      name: true,
      environment: {
        select: { name: true },
      },
    },
  });

  // Get SSH credentials for this environment
  const sshCreds = await getEnvironmentSshKey(environmentId);

  let sshReachable = false;
  let sshError: string | undefined;

  if (sshCreds) {
    // Test SSH connectivity to host
    const sshResult = await testSshConnectivity(
      gatewayIp,
      sshCreds.username,
      sshCreds.privateKey
    );
    sshReachable = sshResult.success;
    sshError = sshResult.error;
  } else {
    sshError = 'SSH key not configured for this environment';
  }

  return {
    detected: true,
    gatewayIp,
    sshReachable,
    sshError,
    registered: !!existingServer,
    registeredGlobally: !!existingServer || !!globalServer,
    registeredEnvironment: existingServer ? undefined : globalServer?.environment.name,
    serverId: existingServer?.id,
    serverName: existingServer?.name,
  };
}

/**
 * Register the Docker host as a server in BridgePort.
 * Uses socket mode if Docker socket is available (preferred for host),
 * otherwise falls back to SSH mode.
 */
export async function registerHostServer(
  environmentId: string,
  name: string = 'host'
): Promise<{ success: boolean; serverId?: string; error?: string }> {
  // Check if already registered
  const existing = await prisma.server.findFirst({
    where: {
      environmentId,
      serverType: 'host',
    },
  });

  if (existing) {
    return {
      success: false,
      error: `Host server already registered as "${existing.name}"`,
    };
  }

  // Detect gateway IP
  const gatewayIp = await detectHostGateway();

  if (!gatewayIp) {
    return { success: false, error: 'Could not detect Docker host gateway' };
  }

  // Check if Docker socket is available (preferred for host server)
  const socketAvailable = await isDockerSocketAvailable();

  if (socketAvailable) {
    // Use socket mode - no SSH required for Docker operations
    const server = await prisma.server.create({
      data: {
        name,
        hostname: gatewayIp,
        tags: JSON.stringify(['host']),
        serverType: 'host',
        dockerMode: 'socket',
        status: 'healthy',
        environmentId,
      },
    });

    return { success: true, serverId: server.id };
  }

  // Fall back to SSH mode
  const sshCreds = await getEnvironmentSshKey(environmentId);
  if (!sshCreds) {
    return { success: false, error: 'SSH key not configured for this environment' };
  }

  const sshTest = await testSshConnectivity(gatewayIp, sshCreds.username, sshCreds.privateKey);
  if (!sshTest.success) {
    return {
      success: false,
      error: `SSH connection to host failed: ${sshTest.error}`,
    };
  }

  const server = await prisma.server.create({
    data: {
      name,
      hostname: gatewayIp,
      tags: JSON.stringify(['host']),
      serverType: 'host',
      dockerMode: 'ssh',
      status: 'healthy',
      environmentId,
    },
  });

  return { success: true, serverId: server.id };
}

/**
 * Bootstrap the management environment with a localhost server.
 * Called on startup to ensure a "management" environment exists.
 * If Docker socket is available, creates a "localhost" server using socket mode.
 * This is the only server that uses socket mode - user-registered servers use SSH.
 */
export async function bootstrapManagementEnvironment(): Promise<void> {
  // Check if management environment exists
  let managementEnv = await prisma.environment.findFirst({
    where: { name: 'management' },
  });

  if (!managementEnv) {
    console.log('Creating management environment...');
    managementEnv = await prisma.environment.create({
      data: {
        name: 'management',
      },
    });
    console.log('Management environment created');
  }

  // Upgrade any host-type servers that are using SSH mode to socket mode if available
  const socketAvailable = await isDockerSocketAvailable();
  if (socketAvailable) {
    const hostServersUsingSSH = await prisma.server.findMany({
      where: {
        serverType: 'host',
        dockerMode: 'ssh',
      },
    });

    for (const server of hostServersUsingSSH) {
      console.log(`Docker socket available - upgrading host server "${server.name}" to socket mode`);
      await prisma.server.update({
        where: { id: server.id },
        data: { dockerMode: 'socket', status: 'healthy' },
      });
    }
  }

  // Check if localhost server already exists in management environment
  const existingLocalhost = await prisma.server.findFirst({
    where: {
      environmentId: managementEnv.id,
      name: 'localhost',
    },
  });

  if (existingLocalhost) {
    return;
  }

  // Check Docker socket availability - only create localhost if socket is available
  const dockerSocketAvailable = await isDockerSocketAvailable();

  if (!dockerSocketAvailable) {
    console.log('Docker socket not available - skipping localhost server creation');
    console.log('Mount /var/run/docker.sock to enable local container management');
    return;
  }

  // Create localhost server with socket mode
  console.log('Creating localhost server with Docker socket mode');
  await prisma.server.create({
    data: {
      name: 'localhost',
      hostname: 'localhost',
      tags: JSON.stringify(['localhost']),
      serverType: 'host',
      dockerMode: 'socket',
      status: 'healthy',
      environmentId: managementEnv.id,
    },
  });
  console.log('Localhost server created in management environment (socket mode)');
}
