/**
 * Server bootstrap orchestrator (issue #113).
 *
 * One-click flow that installs Docker + Compose plugin, the BridgePort agent,
 * applies a sysctl drop-in, and (optionally) configures a swap file on a
 * remote server. Designed for Ubuntu / Debian targets with passwordless sudo
 * (or root SSH). Each component is independently idempotent so re-running the
 * orchestrator after a partial failure resumes safely.
 *
 * Progress is streamed both to a per-call `onLog` callback (for HTTP-attached
 * callers, if any) and to the SSE event bus via `bootstrap_progress` events
 * scoped to the server's environment.
 */

import { prisma } from '../lib/db.js';
import {
  SSHClient,
  LocalClient,
  isLocalhost,
  type CommandClient,
} from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { eventBus } from '../lib/event-bus.js';
import { BOOTSTRAP_STATE } from '../lib/constants.js';
import { getErrorMessage } from '../lib/helpers.js';
import { logAudit, type AuditLogParams } from './audit.js';
import { deployAgent } from './agent-deploy.js';
import {
  dockerInstallScript,
  sysctlScript,
  swapScript,
  distroDetectScript,
  sudoPreflightScript,
} from '../lib/bootstrap-scripts.js';

const SUPPORTED_DISTROS = new Set(['ubuntu', 'debian']);

export type BootstrapComponent = 'docker' | 'sysctl' | 'agent' | 'swap';

export interface BootstrapComponents {
  docker?: boolean;
  sysctl?: boolean;
  agent?: boolean;
  swap?: boolean;
}

export interface BootstrapOptions {
  components: BootstrapComponents;
  swapSizeMb?: number;
  /** Audit-log actor info; forwarded to logAudit. */
  actor?: Pick<AuditLogParams, 'userId' | 'apiTokenId' | 'serviceAccountId'>;
}

export type BootstrapLogger = (line: string, level?: 'info' | 'error') => void;

export interface BootstrapResult {
  success: boolean;
  error?: string;
  components: {
    docker?: { success: boolean; error?: string };
    sysctl?: { success: boolean; error?: string };
    agent?: { success: boolean; error?: string };
    swap?: { success: boolean; error?: string };
  };
}

/** Min/max swap sizes accepted by the API (MB). Keeps callers from accidentally
 *  filling the disk with a 1 TB swap file. */
export const SWAP_MIN_MB = 128;
export const SWAP_MAX_MB = 65536; // 64 GB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a CommandClient for the server — local for localhost, SSH otherwise. */
async function createBootstrapClient(serverId: string): Promise<{
  client: CommandClient | null;
  error?: string;
}> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return { client: null, error: 'Server not found' };

  if (isLocalhost(server.hostname)) {
    return { client: new LocalClient() };
  }
  const sshCreds = await getEnvironmentSshKey(server.environmentId);
  if (!sshCreds) {
    return { client: null, error: 'SSH key not configured for this environment' };
  }
  return {
    client: new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    }),
  };
}

function emitProgress(
  serverId: string,
  environmentId: string,
  component: 'docker' | 'sysctl' | 'agent' | 'swap' | 'distro' | 'preflight' | undefined,
  phase: 'start' | 'step' | 'done' | 'error',
  line: string,
  level: 'info' | 'error' = 'info',
): void {
  eventBus.emitEvent({
    type: 'bootstrap_progress',
    data: { serverId, environmentId, component, phase, level, line },
  });
}

// ---------------------------------------------------------------------------
// Read-only inspectors (used by GET /api/servers/:id/bootstrap)
// ---------------------------------------------------------------------------

/**
 * Detect the target distro. Returns the cached value if a previous bootstrap
 * already recorded one and `force` is false. Updates `Server.bootstrapDistro`
 * as a side effect when it runs.
 */
export async function detectDistro(
  client: CommandClient,
  serverId: string,
): Promise<{ distro: string | null; supported: boolean; raw: string }> {
  const { stdout } = await client.exec(distroDetectScript());
  const raw = stdout.trim();
  if (!raw) return { distro: null, supported: false, raw };

  const [id] = raw.split(':');
  const supported = SUPPORTED_DISTROS.has(id);
  // Cache on the server row for fast subsequent renders.
  await prisma.server.update({
    where: { id: serverId },
    data: { bootstrapDistro: raw },
  });
  return { distro: id, supported, raw };
}

/**
 * Verify that `sudo -n true` succeeds (i.e. passwordless sudo, or the SSH user
 * is already root). Returns a structured result so callers can render a
 * targeted error message.
 */
export async function preflightSudo(client: CommandClient): Promise<{
  ok: boolean;
  error?: string;
}> {
  const { code, stderr, stdout } = await client.exec(sudoPreflightScript());
  if (code === 0) return { ok: true };
  const combined = `${stderr}${stdout}`.trim();
  // Common kernel messages: "a password is required", "sudo: a terminal is required"
  if (/password is required|terminal is required/i.test(combined)) {
    return {
      ok: false,
      error:
        'Passwordless sudo is required. Configure the SSH user with NOPASSWD in /etc/sudoers, or use the root account.',
    };
  }
  return { ok: false, error: combined || 'sudo preflight failed' };
}

// ---------------------------------------------------------------------------
// Component installers
// ---------------------------------------------------------------------------

async function streamCommand(
  client: CommandClient,
  command: string,
  onLine: (line: string, isStderr: boolean) => void,
): Promise<number> {
  return client.execStream(command, (data, isStderr) => {
    // Split on newlines so consumers (SSE, audit log) see one event per line.
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      onLine(line, isStderr);
    }
  });
}

export async function installDocker(
  client: CommandClient,
  log: BootstrapLogger,
): Promise<{ success: boolean; error?: string }> {
  log('[docker] starting');
  const code = await streamCommand(client, dockerInstallScript(), (line, isStderr) => {
    log(line, isStderr ? 'error' : 'info');
  });
  if (code !== 0) {
    return { success: false, error: `Docker install exited with code ${code}` };
  }
  return { success: true };
}

export async function applySysctl(
  client: CommandClient,
  log: BootstrapLogger,
): Promise<{ success: boolean; error?: string }> {
  log('[sysctl] starting');
  const code = await streamCommand(client, sysctlScript(), (line, isStderr) => {
    log(line, isStderr ? 'error' : 'info');
  });
  if (code !== 0) {
    return { success: false, error: `sysctl apply exited with code ${code}` };
  }
  return { success: true };
}

export async function configureSwap(
  client: CommandClient,
  sizeMb: number,
  log: BootstrapLogger,
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isInteger(sizeMb) || sizeMb < SWAP_MIN_MB || sizeMb > SWAP_MAX_MB) {
    return {
      success: false,
      error: `swap size ${sizeMb}MB outside allowed range ${SWAP_MIN_MB}-${SWAP_MAX_MB}MB`,
    };
  }
  log(`[swap] starting (${sizeMb}MB)`);
  const code = await streamCommand(client, swapScript(sizeMb), (line, isStderr) => {
    log(line, isStderr ? 'error' : 'info');
  });
  if (code !== 0) {
    return { success: false, error: `swap configure exited with code ${code}` };
  }
  return { success: true };
}

/**
 * Live-add a swap file to a server without going through the full bootstrap.
 * Captures before/after `free -m` snapshots for the audit log. If swap is
 * already present and `force` is false, fails with a clear message.
 */
export async function addSwapLive(
  serverId: string,
  sizeMb: number,
  options: {
    force?: boolean;
    actor?: Pick<AuditLogParams, 'userId' | 'apiTokenId' | 'serviceAccountId'>;
  } = {},
  log: BootstrapLogger = () => {},
): Promise<{
  success: boolean;
  error?: string;
  before?: string;
  after?: string;
}> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return { success: false, error: 'Server not found' };

  const { client, error } = await createBootstrapClient(serverId);
  if (!client) return { success: false, error };

  try {
    await client.connect();

    // Snapshot current memory usage.
    const beforeRes = await client.exec('free -m');
    const before = beforeRes.stdout;

    // Reject re-runs unless caller explicitly forces.
    if (!options.force) {
      const swaponRes = await client.exec('swapon --show 2>/dev/null || true');
      if (swaponRes.stdout.includes('/swapfile')) {
        return {
          success: false,
          before,
          error: 'Swap file already present; pass force=true to recreate or extend.',
        };
      }
    }

    const sudo = await preflightSudo(client);
    if (!sudo.ok) {
      return { success: false, before, error: sudo.error };
    }

    const result = await configureSwap(client, sizeMb, log);
    if (!result.success) {
      await logAudit({
        action: 'configure_swap',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { sizeMb, before, error: result.error },
        success: false,
        error: result.error,
        environmentId: server.environmentId,
        ...options.actor,
      });
      return { success: false, before, error: result.error };
    }

    const afterRes = await client.exec('free -m');
    const after = afterRes.stdout;

    await prisma.server.update({
      where: { id: serverId },
      data: {
        swapConfigured: true,
        swapConfiguredAt: new Date(),
        swapSizeMb: sizeMb,
      },
    });

    await logAudit({
      action: 'configure_swap',
      resourceType: 'server',
      resourceId: server.id,
      resourceName: server.name,
      details: { sizeMb, before, after, force: options.force ?? false },
      success: true,
      environmentId: server.environmentId,
      ...options.actor,
    });

    return { success: true, before, after };
  } catch (err) {
    const message = getErrorMessage(err, 'addSwapLive failed');
    return { success: false, error: message };
  } finally {
    client.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a full bootstrap. Selected components run in fixed order:
 * `docker → sysctl → swap → agent`. The agent step reuses the existing
 * `agent-deploy.deployAgent()` flow so we don't duplicate that logic here.
 *
 * Component failures do not short-circuit subsequent components — each is
 * recorded in the per-component result map. The server's `bootstrapState` is
 * set to `bootstrapped` only when every requested component succeeded.
 */
export async function runBootstrap(
  serverId: string,
  opts: BootstrapOptions,
  onLog: BootstrapLogger = () => {},
): Promise<BootstrapResult> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return { success: false, error: 'Server not found', components: {} };

  const envId = server.environmentId;
  const log: BootstrapLogger = (line, level = 'info') => {
    onLog(line, level);
    emitProgress(serverId, envId, undefined, 'step', line, level);
  };

  emitProgress(serverId, envId, undefined, 'start', '[bootstrap] starting');

  const { client, error: clientError } = await createBootstrapClient(serverId);
  if (!client) {
    emitProgress(serverId, envId, undefined, 'error', clientError ?? 'no client', 'error');
    await prisma.server.update({
      where: { id: serverId },
      data: { bootstrapState: BOOTSTRAP_STATE.ERROR },
    });
    return { success: false, error: clientError, components: {} };
  }

  const results: BootstrapResult['components'] = {};

  try {
    await client.connect();

    // ---- 1. Distro detect ----
    emitProgress(serverId, envId, 'distro', 'start', '[distro] detecting');
    const distroResult = await detectDistro(client, serverId);
    emitProgress(
      serverId,
      envId,
      'distro',
      'done',
      `[distro] ${distroResult.raw || 'unknown'}`,
    );
    if (!distroResult.supported) {
      const msg = `Unsupported distro: ${distroResult.raw || 'unknown'}. Bootstrap supports Ubuntu and Debian only. See docs/guides/server-bootstrap.md.`;
      emitProgress(serverId, envId, 'distro', 'error', msg, 'error');
      await prisma.server.update({
        where: { id: serverId },
        data: { bootstrapState: BOOTSTRAP_STATE.ERROR },
      });
      await logAudit({
        action: 'bootstrap',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { distro: distroResult.raw, components: opts.components },
        success: false,
        error: msg,
        environmentId: envId,
        ...opts.actor,
      });
      return { success: false, error: msg, components: {} };
    }

    // ---- 2. sudo preflight ----
    emitProgress(serverId, envId, 'preflight', 'start', '[sudo] preflight');
    const sudo = await preflightSudo(client);
    if (!sudo.ok) {
      emitProgress(serverId, envId, 'preflight', 'error', sudo.error ?? 'sudo failed', 'error');
      await prisma.server.update({
        where: { id: serverId },
        data: { bootstrapState: BOOTSTRAP_STATE.ERROR },
      });
      await logAudit({
        action: 'bootstrap',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { components: opts.components, sudoError: sudo.error },
        success: false,
        error: sudo.error,
        environmentId: envId,
        ...opts.actor,
      });
      return { success: false, error: sudo.error, components: {} };
    }
    emitProgress(serverId, envId, 'preflight', 'done', '[sudo] OK');

    // ---- 3. Docker ----
    if (opts.components.docker) {
      emitProgress(serverId, envId, 'docker', 'start', '[docker] installing');
      const r = await installDocker(client, (line, level) => {
        onLog(line, level);
        emitProgress(serverId, envId, 'docker', 'step', line, level);
      });
      results.docker = r;
      if (r.success) {
        await prisma.server.update({
          where: { id: serverId },
          data: { dockerInstalled: true, dockerInstalledAt: new Date() },
        });
        emitProgress(serverId, envId, 'docker', 'done', '[docker] done');
      } else {
        emitProgress(serverId, envId, 'docker', 'error', r.error ?? 'docker failed', 'error');
      }
    }

    // ---- 4. sysctl ----
    if (opts.components.sysctl) {
      emitProgress(serverId, envId, 'sysctl', 'start', '[sysctl] applying');
      const r = await applySysctl(client, (line, level) => {
        onLog(line, level);
        emitProgress(serverId, envId, 'sysctl', 'step', line, level);
      });
      results.sysctl = r;
      if (r.success) {
        await prisma.server.update({
          where: { id: serverId },
          data: { sysctlApplied: true, sysctlAppliedAt: new Date() },
        });
        emitProgress(serverId, envId, 'sysctl', 'done', '[sysctl] done');
      } else {
        emitProgress(serverId, envId, 'sysctl', 'error', r.error ?? 'sysctl failed', 'error');
      }
    }

    // ---- 5. swap ----
    if (opts.components.swap) {
      if (!opts.swapSizeMb) {
        results.swap = { success: false, error: 'swapSizeMb is required when swap is enabled' };
        emitProgress(serverId, envId, 'swap', 'error', results.swap.error!, 'error');
      } else {
        emitProgress(serverId, envId, 'swap', 'start', `[swap] configuring ${opts.swapSizeMb}MB`);
        const r = await configureSwap(client, opts.swapSizeMb, (line, level) => {
          onLog(line, level);
          emitProgress(serverId, envId, 'swap', 'step', line, level);
        });
        results.swap = r;
        if (r.success) {
          await prisma.server.update({
            where: { id: serverId },
            data: {
              swapConfigured: true,
              swapConfiguredAt: new Date(),
              swapSizeMb: opts.swapSizeMb,
            },
          });
          emitProgress(serverId, envId, 'swap', 'done', '[swap] done');
        } else {
          emitProgress(serverId, envId, 'swap', 'error', r.error ?? 'swap failed', 'error');
        }
      }
    }
  } catch (err) {
    const message = getErrorMessage(err, 'bootstrap orchestrator threw');
    emitProgress(serverId, envId, undefined, 'error', message, 'error');
    await prisma.server.update({
      where: { id: serverId },
      data: { bootstrapState: BOOTSTRAP_STATE.ERROR },
    });
    await logAudit({
      action: 'bootstrap',
      resourceType: 'server',
      resourceId: server.id,
      resourceName: server.name,
      details: { components: opts.components, error: message },
      success: false,
      error: message,
      environmentId: envId,
      ...opts.actor,
    });
    return { success: false, error: message, components: results };
  } finally {
    client.disconnect();
  }

  // ---- 6. Agent (uses its own SSH client + flow from agent-deploy.ts) ----
  // Run after the SSH client is closed so we don't conflict over the pool.
  if (opts.components.agent) {
    emitProgress(serverId, envId, 'agent', 'start', '[agent] deploying');
    onLog('[agent] deploying via existing agent-deploy flow');
    const r = await deployAgent(serverId);
    results.agent = r;
    if (r.success) {
      await prisma.server.update({
        where: { id: serverId },
        data: { agentInstalledAt: new Date() },
      });
      emitProgress(serverId, envId, 'agent', 'done', '[agent] done');
    } else {
      emitProgress(serverId, envId, 'agent', 'error', r.error ?? 'agent failed', 'error');
    }
  }

  // ---- Final state ----
  const failed = Object.values(results).some((r) => r && !r.success);
  const finalState = failed ? BOOTSTRAP_STATE.ERROR : BOOTSTRAP_STATE.BOOTSTRAPPED;
  await prisma.server.update({
    where: { id: serverId },
    data: { bootstrapState: finalState },
  });

  await logAudit({
    action: 'bootstrap',
    resourceType: 'server',
    resourceId: server.id,
    resourceName: server.name,
    details: {
      components: opts.components,
      results,
      distro: server.bootstrapDistro,
      swapSizeMb: opts.swapSizeMb,
    },
    success: !failed,
    error: failed ? 'one or more components failed' : undefined,
    environmentId: envId,
    ...opts.actor,
  });

  emitProgress(
    serverId,
    envId,
    undefined,
    failed ? 'error' : 'done',
    failed ? '[bootstrap] completed with errors' : '[bootstrap] done',
    failed ? 'error' : 'info',
  );

  return { success: !failed, components: results };
}
