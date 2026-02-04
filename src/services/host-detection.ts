import { readFile } from 'fs/promises';
import { SSHClient } from '../lib/ssh.js';
import { prisma } from '../lib/db.js';
import { getEnvironmentSshKey } from '../routes/environments.js';

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
    };
  }

  // Check if host server already registered
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
    serverId: existingServer?.id,
    serverName: existingServer?.name,
  };
}

/**
 * Register the Docker host as a server in BridgePort
 */
export async function registerHostServer(
  environmentId: string,
  name: string = 'host'
): Promise<{ success: boolean; serverId?: string; error?: string }> {
  // Detect gateway IP
  const gatewayIp = await detectHostGateway();

  if (!gatewayIp) {
    return { success: false, error: 'Could not detect Docker host gateway' };
  }

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

  // Verify SSH connectivity first
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

  // Create the host server
  const server = await prisma.server.create({
    data: {
      name,
      hostname: gatewayIp,
      tags: JSON.stringify(['host']),
      serverType: 'host',
      status: 'healthy',
      environmentId,
    },
  });

  return { success: true, serverId: server.id };
}

/**
 * Bootstrap the management environment with a host server.
 * Called on startup to ensure a "management" environment exists with a "host" server.
 * This runs without SSH verification since SSH keys may not be configured yet.
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

  // Check if host server already exists in management environment
  const existingHost = await prisma.server.findFirst({
    where: {
      environmentId: managementEnv.id,
      serverType: 'host',
    },
  });

  if (existingHost) {
    return; // Host server already exists
  }

  // Detect gateway IP
  const gatewayIp = await detectHostGateway();
  if (!gatewayIp) {
    console.log('Could not detect Docker host gateway - skipping host server creation');
    return;
  }

  console.log(`Creating host server with gateway IP: ${gatewayIp}`);
  await prisma.server.create({
    data: {
      name: 'host',
      hostname: gatewayIp,
      tags: JSON.stringify(['host']),
      serverType: 'host',
      status: 'unknown', // Will become healthy once SSH is configured and tested
      environmentId: managementEnv.id,
    },
  });
  console.log('Host server created in management environment');
}
