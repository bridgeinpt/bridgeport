import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { getSystemSettings } from './system-settings.js';
import { logAgentEvent } from './agent-events.js';
import crypto from 'crypto';

const AGENT_PATH = join(process.cwd(), 'agent', 'bridgeport-agent');
const AGENT_INSTALL_PATH = '/usr/local/bin/bridgeport-agent';
const SYSTEMD_SERVICE_PATH = '/etc/systemd/system/bridgeport-agent.service';

/**
 * Generate a unique agent token for a server
 */
export function generateAgentToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Get the BridgePort server URL for the agent to connect to.
 * Must be configured in System Settings - no fallbacks.
 * Returns null if not configured.
 */
async function getBridgePortUrl(): Promise<string | null> {
  const settings = await getSystemSettings();
  return settings.agentCallbackUrl || null;
}

/**
 * Deploy the monitoring agent to a server via SSH
 */
export async function deployAgent(
  serverId: string,
  bridgeportUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  // Determine the URL the agent should use to connect back
  // Use provided URL, or get from system settings
  const serverUrl = bridgeportUrl || (await getBridgePortUrl());

  // Validate that callback URL is configured
  if (!serverUrl) {
    return {
      success: false,
      error: 'Agent Callback URL must be configured in System Settings before deploying agents',
    };
  }

  // Generate token if not exists
  let agentToken = server.agentToken;
  if (!agentToken) {
    agentToken = generateAgentToken();
    await prisma.server.update({
      where: { id: serverId },
      data: { agentToken },
    });
  }

  // Set agent status to deploying
  await prisma.server.update({
    where: { id: serverId },
    data: { agentStatus: 'deploying', agentStatusChangedAt: new Date() },
  });

  // Log deploy_started event
  await logAgentEvent({
    serverId,
    eventType: 'deploy_started',
    message: 'Agent deployment initiated',
    details: { serverUrl },
  });

  // Create appropriate client based on hostname
  let client: CommandClient;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) {
      return { success: false, error: 'SSH key not configured for this environment' };
    }
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  try {
    // Read the agent binary
    let agentBinary: Buffer;
    try {
      agentBinary = await readFile(AGENT_PATH);
    } catch {
      return { success: false, error: 'Agent binary not found. Is this a production build?' };
    }

    await client.connect();

    // Transfer agent binary using base64 encoding (works over SSH)
    const agentBase64 = agentBinary.toString('base64');

    // Split into chunks to avoid command line length limits
    const chunkSize = 65000; // Safe size for most systems
    const chunks = [];
    for (let i = 0; i < agentBase64.length; i += chunkSize) {
      chunks.push(agentBase64.slice(i, i + chunkSize));
    }

    // Write chunks to a temp file, then decode
    const tempPath = '/tmp/bridgeport-agent.b64';

    // Stop the agent service if it's running (prevents "Text file busy" error)
    await client.exec('systemctl stop bridgeport-agent 2>/dev/null || true');

    // Clear temp file first
    await client.exec(`rm -f ${tempPath}`);

    // Write chunks
    for (const chunk of chunks) {
      const result = await client.exec(`echo -n '${chunk}' >> ${tempPath}`);
      if (result.code !== 0) {
        throw new Error(`Failed to transfer agent: ${result.stderr}`);
      }
    }

    // Decode and install
    const installResult = await client.exec(
      `base64 -d ${tempPath} > ${AGENT_INSTALL_PATH} && chmod +x ${AGENT_INSTALL_PATH} && rm -f ${tempPath}`
    );
    if (installResult.code !== 0) {
      throw new Error(`Failed to install agent: ${installResult.stderr}`);
    }

    // Create systemd service file
    const serviceContent = `[Unit]
Description=BridgePort Monitoring Agent
After=network.target docker.service

[Service]
Type=simple
Environment="BRIDGEPORT_SERVER=${serverUrl}"
Environment="BRIDGEPORT_TOKEN=${agentToken}"
ExecStart=${AGENT_INSTALL_PATH}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

    const serviceResult = await client.exec(
      `cat > ${SYSTEMD_SERVICE_PATH} << 'SERVICEEOF'\n${serviceContent}SERVICEEOF`
    );
    if (serviceResult.code !== 0) {
      throw new Error(`Failed to create service file: ${serviceResult.stderr}`);
    }

    // Reload systemd, enable and start the service
    const startResult = await client.exec(
      'systemctl daemon-reload && systemctl enable bridgeport-agent && systemctl restart bridgeport-agent'
    );
    if (startResult.code !== 0) {
      throw new Error(`Failed to start agent service: ${startResult.stderr}`);
    }

    // Verify it's running
    const statusResult = await client.exec('systemctl is-active bridgeport-agent');
    if (statusResult.stdout.trim() !== 'active') {
      // Get logs for debugging
      const logsResult = await client.exec('journalctl -u bridgeport-agent -n 20 --no-pager');
      throw new Error(`Agent failed to start. Logs:\n${logsResult.stdout}`);
    }

    client.disconnect();

    // Update server to agent mode and set status to waiting (for first push)
    await prisma.server.update({
      where: { id: serverId },
      data: {
        metricsMode: 'agent',
        agentStatus: 'waiting',
        agentStatusChangedAt: new Date(),
      },
    });

    // Log deploy_success event
    await logAgentEvent({
      serverId,
      eventType: 'deploy_success',
      message: 'Agent deployed successfully',
      details: { serverUrl },
    });

    return { success: true };
  } catch (error) {
    client.disconnect();
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Log deploy_failed event
    await logAgentEvent({
      serverId,
      eventType: 'deploy_failed',
      message: errorMessage,
      details: { serverUrl },
    });

    // Reset agent status on failure
    await prisma.server.update({
      where: { id: serverId },
      data: { agentStatus: 'unknown', agentStatusChangedAt: new Date() },
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * Remove the monitoring agent from a server
 */
export async function removeAgent(serverId: string): Promise<{ success: boolean; error?: string }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  // Create appropriate client based on hostname
  let client: CommandClient;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) {
      return { success: false, error: 'SSH key not configured for this environment' };
    }
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  try {
    await client.connect();

    // Stop and disable the service
    await client.exec('systemctl stop bridgeport-agent 2>/dev/null || true');
    await client.exec('systemctl disable bridgeport-agent 2>/dev/null || true');

    // Remove files
    await client.exec(`rm -f ${SYSTEMD_SERVICE_PATH}`);
    await client.exec(`rm -f ${AGENT_INSTALL_PATH}`);
    await client.exec('systemctl daemon-reload');

    client.disconnect();

    // Update server
    await prisma.server.update({
      where: { id: serverId },
      data: { metricsMode: 'disabled', agentToken: null },
    });

    return { success: true };
  } catch (error) {
    client.disconnect();
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Check if the agent is running on a server
 */
export async function checkAgentStatus(
  serverId: string
): Promise<{ installed: boolean; running: boolean; error?: string }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) {
    return { installed: false, running: false, error: 'Server not found' };
  }

  // Create appropriate client based on hostname
  let client: CommandClient;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) {
      return { installed: false, running: false, error: 'SSH key not configured' };
    }
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  try {
    await client.connect();

    // Check if binary exists
    const binaryCheck = await client.exec(`test -f ${AGENT_INSTALL_PATH} && echo "yes" || echo "no"`);
    const installed = binaryCheck.stdout.trim() === 'yes';

    // Check if service is running
    const statusResult = await client.exec('systemctl is-active bridgeport-agent 2>/dev/null || echo "inactive"');
    const running = statusResult.stdout.trim() === 'active';

    client.disconnect();

    return { installed, running };
  } catch (error) {
    client.disconnect();
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { installed: false, running: false, error: message };
  }
}
