import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for `triggerAutoResyncForKey` and `syncConfigFileToAttachedServices`.
 *
 * Coverage notes:
 *   - The service-layer trigger behavior (Prisma filter shape, audit details,
 *     cycle protection per row, resilience on partial failures, top-level
 *     try/catch) is covered here.
 *   - The PATCH route wiring (`/api/vars/:id`, `/api/secrets/:id`) is NOT
 *     covered by unit tests in this file. Mocking the secret-decryption helper
 *     plus the full Fastify stack proved noisier than valuable; the high-value
 *     behavior is the service itself, which routes fire-and-forget into.
 */

const { mockPrisma, mockSSHClientInstance } = vi.hoisted(() => ({
  mockPrisma: {
    configFile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    serviceFile: {
      update: vi.fn(),
    },
  },
  mockSSHClientInstance: {
    connect: vi.fn(),
    exec: vi.fn(),
    disconnect: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  createClientForServer: vi.fn(),
  // Real-ish escaping so any assertions about command strings remain meaningful
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({
    username: 'root',
    privateKey: 'fake-key',
  }),
}));

vi.mock('./secrets.js', () => ({
  resolveSecretPlaceholders: vi.fn(),
}));

vi.mock('./audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import {
  triggerAutoResyncForKey,
  syncConfigFileToAttachedServices,
} from './config-file-auto-resync.js';
import { createClientForServer } from '../lib/ssh.js';
import { resolveSecretPlaceholders } from './secrets.js';
import { logAudit } from './audit.js';

/** Build a ConfigFile row with one attached service (and one server). */
function buildConfigFileFixture(overrides?: {
  id?: string;
  name?: string;
  content?: string;
  isBinary?: boolean;
  attached?: boolean;
}) {
  const id = overrides?.id ?? 'cf-1';
  return {
    id,
    name: overrides?.name ?? 'nginx.conf',
    content: overrides?.content ?? 'upstream { server ${UPSTREAMS}; }',
    isBinary: overrides?.isBinary ?? false,
    environmentId: 'env-1',
    autoResync: true,
    services:
      overrides?.attached === false
        ? []
        : [
            {
              id: 'sf-1',
              configFileId: overrides?.id ?? 'cf-1',
              targetPath: '/etc/nginx/nginx.conf',
              // kind=base: serviceDeployment is null; fans out to service.serviceDeployments below.
              serviceDeployment: null,
              service: {
                id: 'svc-1',
                name: 'web',
                serviceDeployments: [
                  {
                    id: 'dep-1',
                    server: {
                      id: 'srv-1',
                      name: 'host-a',
                      hostname: '10.0.0.1',
                      environmentId: 'env-1',
                      serverType: 'docker',
                    },
                  },
                ],
              },
            },
          ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Sensible defaults; individual tests override as needed.
  mockSSHClientInstance.connect.mockResolvedValue(undefined);
  mockSSHClientInstance.exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  mockSSHClientInstance.disconnect.mockReturnValue(undefined);
  mockSSHClientInstance.writeFile.mockResolvedValue(undefined);

  vi.mocked(createClientForServer).mockResolvedValue({ client: mockSSHClientInstance as any });
  vi.mocked(resolveSecretPlaceholders).mockResolvedValue({
    content: 'upstream { server 1.2.3.4; }',
    missing: [],
    templateErrors: [],
  });
});

describe('triggerAutoResyncForKey', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('queries Prisma with the correct filter shape and syncs matching files', async () => {
    const cf = buildConfigFileFixture();
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: cf.id, name: cf.name, content: cf.content },
    ]);
    mockPrisma.configFile.findUnique.mockResolvedValue(cf);

    await triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch');

    // Filter must include the literal ${UPSTREAMS} so prefix matches (e.g.
    // ${UPSTREAMS_BACKUP}) don't trigger a sync.
    expect(mockPrisma.configFile.findMany).toHaveBeenCalledWith({
      where: {
        environmentId: 'env-1',
        autoResync: true,
        isBinary: false,
        content: { contains: '${UPSTREAMS}' },
      },
      select: { id: true, name: true, content: true },
    });

    // Audit log records the trigger source on the auto path.
    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.action).toBe('sync_files');
    expect(auditCall.resourceType).toBe('config_file');
    expect(auditCall.resourceId).toBe(cf.id);
    expect(auditCall.environmentId).toBe('env-1');
    expect(auditCall.success).toBe(true);
    const details = auditCall.details as Record<string, unknown>;
    expect(details.autoTriggered).toBe(true);
    expect(details.triggeredBy).toBe('var:UPSTREAMS:patch');
    expect(details.syncedTo).toBe(1);
  });

  it('syncs each matching ConfigFile only once even with multiple placeholder occurrences', async () => {
    // The cycle-protection guarantee: regardless of how many times ${UPSTREAMS}
    // appears inside the file body, this is still ONE row → ONE sync → ONE audit.
    const cf = buildConfigFileFixture({
      content: 'a ${UPSTREAMS} b ${UPSTREAMS} c ${UPSTREAMS}',
    });
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: cf.id, name: cf.name, content: cf.content },
    ]);
    mockPrisma.configFile.findUnique.mockResolvedValue(cf);

    await triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch');

    expect(mockPrisma.configFile.findUnique).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('returns early without audit when no candidates match', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([]);

    await triggerAutoResyncForKey('env-1', 'NOPE', 'var:NOPE:patch');

    expect(mockPrisma.configFile.findUnique).not.toHaveBeenCalled();
    expect(createClientForServer).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('one failing file does not prevent the rest from syncing', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-bad', name: 'bad.conf', content: '${UPSTREAMS}' },
      { id: 'cf-good', name: 'good.conf', content: '${UPSTREAMS}' },
    ]);

    // First findUnique call (cf-bad) rejects; second resolves to a real file.
    mockPrisma.configFile.findUnique
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(buildConfigFileFixture({ id: 'cf-good', name: 'good.conf' }));

    await triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch');

    // The good one still got its audit entry.
    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.resourceId).toBe('cf-good');

    // Failure was logged but did not throw.
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('resolves cleanly when findMany itself throws', async () => {
    mockPrisma.configFile.findMany.mockRejectedValue(new Error('db dead'));

    await expect(
      triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch')
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('post-filters out SQL LIKE underscore-wildcard false positives', async () => {
    // SQLite LIKE treats `_` as single-char wildcard, and Prisma does NOT
    // escape it. For key `FOO_BAR`, the coarse SQL filter `%${FOO_BAR}%` would
    // match a row whose content contains `${FOOXBAR}`. The JS post-filter must
    // drop that row and only sync the file with the literal placeholder.
    const matchingRow = {
      id: 'cf-match',
      name: 'match.conf',
      content: 'use ${FOO_BAR} here',
    };
    const falsePositiveRow = {
      id: 'cf-falsepos',
      name: 'falsepos.conf',
      // `_` in `FOO_BAR` matches `X` under SQL LIKE, so SQLite would surface
      // this row even though it does not literally reference ${FOO_BAR}.
      content: 'use ${FOOXBAR} here',
    };
    mockPrisma.configFile.findMany.mockResolvedValue([matchingRow, falsePositiveRow]);
    mockPrisma.configFile.findUnique.mockResolvedValue(
      buildConfigFileFixture({ id: 'cf-match', name: 'match.conf' })
    );

    await triggerAutoResyncForKey('env-1', 'FOO_BAR', 'var:FOO_BAR:patch');

    // Only the literal-match row should have been fetched for sync; the
    // false-positive row must be filtered out before any per-row work runs.
    expect(mockPrisma.configFile.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.configFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cf-match' } })
    );

    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.resourceId).toBe('cf-match');
  });

  it('propagates actor identity fields into the audit log row', async () => {
    const cf = buildConfigFileFixture();
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: cf.id, name: cf.name, content: cf.content },
    ]);
    mockPrisma.configFile.findUnique.mockResolvedValue(cf);

    await triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch', {
      userId: 'user-42',
      apiTokenId: 'tok-7',
    });

    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.userId).toBe('user-42');
    expect(auditCall.apiTokenId).toBe('tok-7');
    // Trigger metadata is still on details so we can distinguish from
    // operator-initiated syncs.
    const details = auditCall.details as Record<string, unknown>;
    expect(details.autoTriggered).toBe(true);
    expect(details.triggeredBy).toBe('var:UPSTREAMS:patch');
  });

  it('audit details.allSuccess reflects partial server failures', async () => {
    const cf = buildConfigFileFixture();
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: cf.id, name: cf.name, content: cf.content },
    ]);
    mockPrisma.configFile.findUnique.mockResolvedValue(cf);

    // Simulate SSH client creation failure for the (only) server.
    vi.mocked(createClientForServer).mockResolvedValue({
      client: null,
      error: 'SSH key not configured for this environment',
    });

    await triggerAutoResyncForKey('env-1', 'UPSTREAMS', 'var:UPSTREAMS:patch');

    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.success).toBe(false);
    const details = auditCall.details as Record<string, unknown>;
    expect(details.allSuccess).toBe(false);
    expect(details.autoTriggered).toBe(true);
  });
});

describe('syncConfigFileToAttachedServices', () => {
  it('returns null when the ConfigFile is not found', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(null);

    const result = await syncConfigFileToAttachedServices('missing');

    expect(result).toBeNull();
    expect(createClientForServer).not.toHaveBeenCalled();
  });

  it('returns null when the ConfigFile has zero attached services', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(
      buildConfigFileFixture({ attached: false })
    );

    const result = await syncConfigFileToAttachedServices('cf-1');

    expect(result).toBeNull();
    expect(createClientForServer).not.toHaveBeenCalled();
  });

  it('marks every ServiceFile under a failed-SSH server as failed (and does not throw)', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(buildConfigFileFixture());
    vi.mocked(createClientForServer).mockResolvedValue({
      client: null,
      error: 'SSH key not configured for this environment',
    });

    const result = await syncConfigFileToAttachedServices('cf-1');

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.results).toHaveLength(1);
    expect(result!.results[0]).toMatchObject({
      serviceId: 'svc-1',
      success: false,
      error: 'SSH key not configured for this environment',
    });
    expect(mockPrisma.serviceFile.update).not.toHaveBeenCalled();
  });

  it('reports missing secrets without writing the file or updating lastSyncedAt', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(buildConfigFileFixture());
    vi.mocked(resolveSecretPlaceholders).mockResolvedValue({
      content: 'upstream { server ${SECRET_A}; }',
      missing: ['SECRET_A'],
      templateErrors: [],
    });

    const result = await syncConfigFileToAttachedServices('cf-1');

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.results[0]).toMatchObject({
      success: false,
      error: 'Missing secrets: SECRET_A',
    });
    expect(mockPrisma.serviceFile.update).not.toHaveBeenCalled();

    // The second exec — the cat-heredoc that actually writes the file — must
    // not have run. Only the mkdir -p targetDir is allowed.
    const execCalls = mockSSHClientInstance.exec.mock.calls.map((c) => c[0] as string);
    expect(execCalls.some((cmd) => cmd.startsWith('cat >'))).toBe(false);
  });

  it('happy path: writes file, updates lastSyncedAt, returns success', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(buildConfigFileFixture());

    const result = await syncConfigFileToAttachedServices('cf-1');

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.results).toHaveLength(1);
    expect(result!.results[0]).toMatchObject({
      serviceId: 'svc-1',
      success: true,
    });

    // lastSyncedAt should be updated for the synced ServiceFile.
    expect(mockPrisma.serviceFile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sf-1' },
        data: expect.objectContaining({ lastSyncedAt: expect.any(Date) }),
      })
    );

    // Client lifecycle: connect + disconnect (disconnect via finally).
    expect(mockSSHClientInstance.connect).toHaveBeenCalledTimes(1);
    expect(mockSSHClientInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  it('non-zero exec exit code surfaces as a failed result with stderr', async () => {
    mockPrisma.configFile.findUnique.mockResolvedValue(buildConfigFileFixture());
    // First exec is mkdir (ok), second is the cat-heredoc write (fails).
    mockSSHClientInstance.exec
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'permission denied' });

    const result = await syncConfigFileToAttachedServices('cf-1');

    expect(result!.success).toBe(false);
    expect(result!.results[0]).toMatchObject({
      success: false,
      error: 'permission denied',
    });
    expect(mockPrisma.serviceFile.update).not.toHaveBeenCalled();
  });
});
