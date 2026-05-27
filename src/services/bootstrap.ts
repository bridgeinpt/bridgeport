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
  createClientForServer,
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
  /**
   * Internal: set by the HTTP route after `tryAcquireBootstrapLock` succeeds.
   * Tells runBootstrap that the bootstrap lock is already held by the caller,
   * so the function should proceed (rather than refuse) and still release the
   * lock in its finally block. Not part of the public API.
   */
  _lockHeldByCaller?: boolean;
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

/** Set of serverIds currently running a bootstrap. Used to reject concurrent
 *  runs at the route layer. Single-process semantics — fine for BridgePort's
 *  single-instance deployment model. */
const runningBootstraps = new Set<string>();

/** Returns true if a bootstrap is already running for this server. */
export function isBootstrapRunning(serverId: string): boolean {
  return runningBootstraps.has(serverId);
}

/**
 * Atomically attempt to acquire the bootstrap lock for a server. Returns true
 * if the caller now owns the lock (must release via `releaseBootstrapLock`),
 * false if another caller already holds it. Use this from route handlers so
 * the 409 decision is taken synchronously before kicking off the async
 * `runBootstrap` (avoids the await-yield race where two parallel requests
 * both pass an `isBootstrapRunning` check).
 */
export function tryAcquireBootstrapLock(serverId: string): boolean {
  if (runningBootstraps.has(serverId)) return false;
  runningBootstraps.add(serverId);
  return true;
}

/** Release the bootstrap lock. Idempotent — safe to call from finally. */
export function releaseBootstrapLock(serverId: string): void {
  runningBootstraps.delete(serverId);
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
 * Detect the target distro. Updates `Server.bootstrapDistro` as a side effect
 * only when the detected value differs from `cachedDistro` (so a repeat probe
 * from the GET endpoint doesn't write on every poll).
 */
export async function detectDistro(
  client: CommandClient,
  serverId: string,
  cachedDistro?: string | null,
): Promise<{ distro: string | null; supported: boolean; raw: string }> {
  const { stdout } = await client.exec(distroDetectScript());
  const raw = stdout.trim();
  if (!raw) return { distro: null, supported: false, raw };

  const [id] = raw.split(':');
  const supported = SUPPORTED_DISTROS.has(id);
  // Cache on the server row only when the value has changed (skip no-op writes).
  if (raw !== cachedDistro) {
    await prisma.server.update({
      where: { id: serverId },
      data: { bootstrapDistro: raw },
    });
  }
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
  // SSH chunks can split a single log line across two onData callbacks. Buffer
  // the trailing partial line per stream and prepend it to the next chunk so we
  // emit exactly one event per logical newline-terminated line.
  let stdoutBuf = '';
  let stderrBuf = '';
  const code = await client.execStream(command, (data, isStderr) => {
    const prefix = isStderr ? stderrBuf : stdoutBuf;
    const combined = prefix + data;
    const parts = combined.split('\n');
    // Last element is the partial trailing fragment (no newline yet).
    const trailing = parts.pop() ?? '';
    if (isStderr) stderrBuf = trailing;
    else stdoutBuf = trailing;
    for (const line of parts) {
      if (line.length === 0) continue;
      onLine(line, isStderr);
    }
  });
  // Flush any remaining buffered content as final lines.
  if (stdoutBuf.length > 0) onLine(stdoutBuf, false);
  if (stderrBuf.length > 0) onLine(stderrBuf, true);
  return code;
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

  const { client, error } = await createClientForServer(
    server.hostname,
    server.environmentId,
    getEnvironmentSshKey,
    { serverType: server.serverType },
  );
  if (!client) return { success: false, error };

  try {
    await client.connect();

    // Snapshot current memory usage.
    const beforeRes = await client.exec('free -m');
    const before = beforeRes.stdout;

    // Reject re-runs unless caller explicitly forces.
    if (!options.force) {
      const swaponRes = await client.exec('swapon --show 2>/dev/null || true');
      // Anchor on `/swapfile` at start of line followed by whitespace so we
      // don't false-positive on `/swapfile.bak`, `/data/swapfile`, etc.
      if (/^\/swapfile\s/m.test(swaponRes.stdout)) {
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
  // Acquire the lock synchronously at function entry (before any await) so
  // direct callers can't race. The route layer uses `tryAcquireBootstrapLock`
  // to atomically check + acquire before kicking off this call; in that case
  // the entry below sees the lock already held and skips re-acquisition.
  // Either way, the outer try/finally below releases the lock exactly once.
  const acquiredHere = !runningBootstraps.has(serverId);
  if (acquiredHere) runningBootstraps.add(serverId);
  else if (!opts._lockHeldByCaller) {
    return { success: false, error: 'Bootstrap already running for this server', components: {} };
  }

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    runningBootstraps.delete(serverId);
    return { success: false, error: 'Server not found', components: {} };
  }

  const envId = server.environmentId;
  const log: BootstrapLogger = (line, level = 'info') => {
    onLog(line, level);
    emitProgress(serverId, envId, undefined, 'step', line, level);
  };

  // Centralise the cleanup + terminal-event emission shared by every early-
  // return failure path. Always emits a final SSE event with component=undefined
  // so the UI modal's "running=false" toggle fires (see BootstrapModal.tsx).
  const finalizeError = async (
    message: string,
    auditDetails: Record<string, unknown>,
  ): Promise<void> => {
    await prisma.server.update({
      where: { id: serverId },
      data: { bootstrapState: BOOTSTRAP_STATE.ERROR },
    });
    await logAudit({
      action: 'bootstrap',
      resourceType: 'server',
      resourceId: server.id,
      resourceName: server.name,
      details: auditDetails,
      success: false,
      error: message,
      environmentId: envId,
      ...opts.actor,
    });
    emitProgress(
      serverId,
      envId,
      undefined,
      'error',
      `[bootstrap] aborted: ${message}`,
      'error',
    );
  };

  // Outer try/finally guarantees the lock is released even on early-return
  // failure paths (unsupported distro, sudo failure, exceptions). Note: the
  // outer body is intentionally not re-indented so the diff vs. the previous
  // structure stays readable; only the lock-release semantics changed.
  try {
  emitProgress(serverId, envId, undefined, 'start', '[bootstrap] starting');

  const { client, error: clientError } = await createClientForServer(
    server.hostname,
    server.environmentId,
    getEnvironmentSshKey,
    { serverType: server.serverType },
  );
  if (!client) {
    const msg = clientError ?? 'no client';
    await finalizeError(msg, { components: opts.components, error: msg });
    return { success: false, error: clientError, components: {} };
  }

  const results: BootstrapResult['components'] = {};

  try {
    await client.connect();

    // ---- 1. Distro detect ----
    emitProgress(serverId, envId, 'distro', 'start', '[distro] detecting');
    const distroResult = await detectDistro(client, serverId, server.bootstrapDistro);
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
      await finalizeError(msg, {
        distro: distroResult.raw,
        components: opts.components,
      });
      return { success: false, error: msg, components: {} };
    }

    // ---- 2. sudo preflight ----
    emitProgress(serverId, envId, 'preflight', 'start', '[sudo] preflight');
    const sudo = await preflightSudo(client);
    if (!sudo.ok) {
      const msg = sudo.error ?? 'sudo failed';
      emitProgress(serverId, envId, 'preflight', 'error', msg, 'error');
      await finalizeError(msg, {
        components: opts.components,
        sudoError: sudo.error,
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
        // If /swapfile is already active, the swap script no-ops on size. We
        // must not lie about size in the DB — probe first and skip the size
        // update when an existing swapfile is present.
        const swaponRes = await client.exec('swapon --show 2>/dev/null || true');
        const swapAlreadyOn = /^\/swapfile\s/m.test(swaponRes.stdout);
        emitProgress(serverId, envId, 'swap', 'start', `[swap] configuring ${opts.swapSizeMb}MB`);
        const r = await configureSwap(client, opts.swapSizeMb, (line, level) => {
          onLog(line, level);
          emitProgress(serverId, envId, 'swap', 'step', line, level);
        });
        results.swap = r;
        if (r.success) {
          if (swapAlreadyOn) {
            // Keep existing size — only flip the boolean + timestamp.
            await prisma.server.update({
              where: { id: serverId },
              data: {
                swapConfigured: true,
                swapConfiguredAt: new Date(),
              },
            });
            emitProgress(
              serverId,
              envId,
              'swap',
              'done',
              '[swap] /swapfile already present — kept existing size',
            );
          } else {
            await prisma.server.update({
              where: { id: serverId },
              data: {
                swapConfigured: true,
                swapConfiguredAt: new Date(),
                swapSizeMb: opts.swapSizeMb,
              },
            });
            emitProgress(serverId, envId, 'swap', 'done', '[swap] done');
          }
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
  } finally {
    runningBootstraps.delete(serverId);
  }
}
