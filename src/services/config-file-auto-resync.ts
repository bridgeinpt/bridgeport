import { prisma } from '../lib/db.js';
import { createClientForServer, shellEscape } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { resolveSecretPlaceholders, getSecretsForEnv } from './secrets.js';
import { logAudit } from './audit.js';
import {
  redactSecretValues,
  unifiedDiff,
  type ConfigSyncDryRunReport,
  type ConfigSyncTarget,
} from '../lib/dry-run.js';

/**
 * Actor fields used to attribute the auto-triggered audit log row to the user
 * (or service account) whose PATCH started the cascade. Shape matches what
 * `actorFrom(request)` returns in `./audit.ts`.
 */
export interface AutoResyncActor {
  userId?: string;
  apiTokenId?: string;
  serviceAccountId?: string;
}
import { getErrorMessage } from '../lib/helpers.js';
import { composeFragmentedContent } from '../lib/config-fragments.js';

/**
 * Result of one (service-file, server) sync attempt during an auto-resync run.
 */
export interface AutoResyncResult {
  serviceId: string;
  serviceName: string;
  serverName: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

/**
 * Terminal status of a sync run (issue #127).
 *
 * - `ok`           : all targets succeeded.
 * - `no_targets`   : zero targets — the config file isn't attached anywhere, or
 *                    the server/service has nothing to sync. Distinct from `ok`
 *                    so callers can surface "did nothing" as a warning instead
 *                    of green success.
 * - `partial`      : at least one target succeeded and at least one failed.
 * - `failed`       : every target failed.
 */
export type SyncStatus = 'ok' | 'no_targets' | 'partial' | 'failed';

/**
 * Compute the terminal SyncStatus for an array of per-target results.
 * Exported so the route handlers that build their own results arrays
 * (sync-files, sync-all-files) stay in lockstep with this module's contract.
 */
export function deriveSyncStatus(results: ReadonlyArray<{ success: boolean }>): SyncStatus {
  if (results.length === 0) return 'no_targets';
  const succeeded = results.filter((r) => r.success).length;
  if (succeeded === results.length) return 'ok';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

/**
 * Sync a single ConfigFile to every service it is attached to.
 *
 * This is the extracted core of `POST /api/config-files/:id/sync-all` so it can
 * be reused by the auto-resync trigger without duplicating SSH/SFTP plumbing.
 *
 * The function is "best effort": SSH or per-file failures are recorded in the
 * returned results array but never thrown. Callers decide how to surface
 * partial failures (HTTP route returns 207-ish payload, background trigger
 * just logs).
 */
export interface SyncOutcome {
  results: AutoResyncResult[];
  /** @deprecated retained for one release; use `status` instead (issue #127). */
  success: boolean;
  status: SyncStatus;
  targetsAttempted: number;
  targetsSucceeded: number;
  targetsFailed: number;
  configFileName: string;
  environmentId: string;
}

export async function syncConfigFileToAttachedServices(
  configFileId: string
): Promise<SyncOutcome | null> {
  const configFile = await prisma.configFile.findUnique({
    where: { id: configFileId },
    include: {
      // Ordered fragment includes — concatenated before the ConfigFile's own
      // content at sync render time so both the live and dry-run paths emit
      // the same effective blob.
      includedFragments: {
        include: { fragment: true },
        orderBy: { position: 'asc' },
      },
      services: {
        include: {
          service: { include: { serviceDeployments: { include: { server: true } } } },
          serviceDeployment: { include: { server: true } },
        },
      },
    },
  });

  // The ConfigFile itself doesn't exist — true 404. Callers translate `null`
  // to a 404 NOT_FOUND envelope. Zero-attachments is no longer a `null` return:
  // it falls through to a successful `no_targets` outcome so the caller can
  // surface a yellow warning instead of a red error (issue #127).
  if (!configFile) {
    return null;
  }

  if (configFile.services.length === 0) {
    return {
      results: [],
      success: false,
      status: 'no_targets',
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      configFileName: configFile.name,
      environmentId: configFile.environmentId,
    };
  }

  const results: AutoResyncResult[] = [];

  // Expand each ServiceFile to one or more (serviceFile, server) pairs:
  //  - kind=override row: applies to exactly that ServiceDeployment's server.
  //  - kind=base   row:   applies to every deployment of the parent service that doesn't have an override.
  type Pair = { sf: typeof configFile.services[number]; serviceDeploymentId: string; server: typeof configFile.services[number]['service']['serviceDeployments'][number]['server']; serviceName: string };
  const pairs: Pair[] = [];

  // First pass: collect override rows and remember which deployments they cover.
  const overrideCovered = new Map<string, Set<string>>(); // configFileId -> serviceDeploymentIds covered
  for (const sf of configFile.services) {
    if (sf.serviceDeployment) {
      pairs.push({ sf, serviceDeploymentId: sf.serviceDeployment.id, server: sf.serviceDeployment.server, serviceName: sf.service.name });
      if (!overrideCovered.has(sf.configFileId)) overrideCovered.set(sf.configFileId, new Set());
      overrideCovered.get(sf.configFileId)!.add(sf.serviceDeployment.id);
    }
  }
  // Second pass: base rows fan out to every deployment of their service not already overridden.
  for (const sf of configFile.services) {
    if (sf.serviceDeployment) continue;
    const covered = overrideCovered.get(sf.configFileId) ?? new Set<string>();
    for (const sd of sf.service.serviceDeployments) {
      if (covered.has(sd.id)) continue;
      pairs.push({ sf, serviceDeploymentId: sd.id, server: sd.server, serviceName: sf.service.name });
    }
  }

  // Group pairs by server to minimize SSH connections
  const serverGroups = new Map<string, Pair[]>();
  for (const p of pairs) {
    if (!serverGroups.has(p.server.id)) serverGroups.set(p.server.id, []);
    serverGroups.get(p.server.id)!.push(p);
  }

  for (const [, group] of serverGroups) {
    const server = group[0].server;

    const { client, error: clientError } = await createClientForServer(
      server.hostname,
      server.environmentId,
      getEnvironmentSshKey,
      { serverType: server.serverType }
    );

    if (!client) {
      for (const p of group) {
        results.push({
          serviceId: p.sf.service.id,
          serviceName: p.serviceName,
          serverName: server.name,
          targetPath: p.sf.targetPath,
          success: false,
          error: clientError || 'Failed to create SSH client',
        });
      }
      continue;
    }

    try {
      await client.connect();

      for (const p of group) {
        const sf = p.sf;
        try {
          const targetDir = sf.targetPath.substring(0, sf.targetPath.lastIndexOf('/'));
          await client.exec(`mkdir -p ${shellEscape(targetDir)}`);

          let code: number;
          let stderr: string;

          if (configFile.isBinary) {
            const fileBuffer = Buffer.from(configFile.content, 'base64');
            try {
              await client.writeFile(sf.targetPath, fileBuffer);
              code = 0;
              stderr = '';
            } catch (writeErr) {
              code = 1;
              stderr = writeErr instanceof Error ? writeErr.message : 'SFTP write failed';
            }
          } else {
            const composedSource = composeFragmentedContent(
              configFile.includedFragments.map((f) => ({
                name: f.fragment.name,
                content: f.fragment.content,
              })),
              configFile.content,
              configFile.language,
            );
            const { content: rawContent, missing, templateErrors } = await resolveSecretPlaceholders(
              server.environmentId,
              composedSource
            );
            const resolvedContent = rawContent.trimEnd();

            if (templateErrors.length > 0) {
              results.push({
                serviceId: sf.service.id,
                serviceName: p.serviceName,
                serverName: server.name,
                targetPath: sf.targetPath,
                success: false,
                error: `Template errors: ${templateErrors.join('; ')}`,
              });
              continue;
            }

            if (missing.length > 0) {
              results.push({
                serviceId: sf.service.id,
                serviceName: p.serviceName,
                serverName: server.name,
                targetPath: sf.targetPath,
                success: false,
                error: `Missing secrets: ${missing.join(', ')}`,
              });
              continue;
            }

            ({ code, stderr } = await client.exec(
              `cat > ${shellEscape(sf.targetPath)} << 'CONFIGFILE_EOF'\n${resolvedContent}\nCONFIGFILE_EOF`
            ));
          }

          if (code !== 0) {
            results.push({
              serviceId: sf.service.id,
              serviceName: p.serviceName,
              serverName: server.name,
              targetPath: sf.targetPath,
              success: false,
              error: stderr || 'Failed to write file',
            });
          } else {
            await prisma.serviceFile.update({
              where: { id: sf.id },
              data: { lastSyncedAt: new Date() },
            });
            results.push({
              serviceId: sf.service.id,
              serviceName: p.serviceName,
              serverName: server.name,
              targetPath: sf.targetPath,
              success: true,
            });
          }
        } catch (err) {
          results.push({
            serviceId: sf.service.id,
            serviceName: p.serviceName,
            serverName: server.name,
            targetPath: sf.targetPath,
            success: false,
            error: getErrorMessage(err, 'Unknown error'),
          });
        }
      }
    } catch (error) {
      for (const p of group) {
        results.push({
          serviceId: p.sf.service.id,
          serviceName: p.serviceName,
          serverName: server.name,
          targetPath: p.sf.targetPath,
          success: false,
          error: getErrorMessage(error, 'Connection failed'),
        });
      }
    } finally {
      client.disconnect();
    }
  }

  const status = deriveSyncStatus(results);
  const targetsAttempted = results.length;
  const targetsSucceeded = results.filter((r) => r.success).length;
  const targetsFailed = targetsAttempted - targetsSucceeded;
  // `success` is deprecated (issue #127) — kept as a top-level alias for one
  // release so older clients keep working. True iff all targets succeeded.
  const success = status === 'ok';

  return {
    results,
    success,
    status,
    targetsAttempted,
    targetsSucceeded,
    targetsFailed,
    configFileName: configFile.name,
    environmentId: configFile.environmentId,
  };
}

/**
 * Dry-run preview of `syncConfigFileToAttachedServices`. For each target,
 * returns the unified diff between the current host file and the rendered
 * (redacted) content that would be written — without writing the file or
 * touching `lastSyncedAt`.
 *
 * Binary files are not diffed (no useful line view); their target is reported
 * with an empty diff and a warning.
 *
 * Returns `null` when the ConfigFile itself doesn't exist (true 404). Zero
 * attachments returns an empty `results` array — same shape as the real path.
 */
export async function syncConfigFileToAttachedServicesDryRun(
  configFileId: string
): Promise<ConfigSyncDryRunReport | null> {
  const configFile = await prisma.configFile.findUnique({
    where: { id: configFileId },
    include: {
      // Ordered fragment includes — concatenated before the ConfigFile's own
      // content at sync render time so both the live and dry-run paths emit
      // the same effective blob.
      includedFragments: {
        include: { fragment: true },
        orderBy: { position: 'asc' },
      },
      services: {
        include: {
          service: { include: { serviceDeployments: { include: { server: true } } } },
          serviceDeployment: { include: { server: true } },
        },
      },
    },
  });

  if (!configFile) return null;

  // Same fan-out logic as syncConfigFileToAttachedServices — kept inline rather
  // than extracted so the live and dry-run paths stay easy to keep in lockstep.
  type Pair = {
    sf: typeof configFile.services[number];
    serviceDeploymentId: string;
    server: typeof configFile.services[number]['service']['serviceDeployments'][number]['server'];
    serviceName: string;
  };
  const pairs: Pair[] = [];
  const overrideCovered = new Map<string, Set<string>>();
  for (const sf of configFile.services) {
    if (sf.serviceDeployment) {
      pairs.push({ sf, serviceDeploymentId: sf.serviceDeployment.id, server: sf.serviceDeployment.server, serviceName: sf.service.name });
      if (!overrideCovered.has(sf.configFileId)) overrideCovered.set(sf.configFileId, new Set());
      overrideCovered.get(sf.configFileId)!.add(sf.serviceDeployment.id);
    }
  }
  for (const sf of configFile.services) {
    if (sf.serviceDeployment) continue;
    const covered = overrideCovered.get(sf.configFileId) ?? new Set<string>();
    for (const sd of sf.service.serviceDeployments) {
      if (covered.has(sd.id)) continue;
      pairs.push({ sf, serviceDeploymentId: sd.id, server: sd.server, serviceName: sf.service.name });
    }
  }

  const results: ConfigSyncTarget[] = [];
  if (pairs.length === 0) {
    return { dryRun: true, results: [] };
  }

  // Group pairs by server so we open one SSH connection per host. Important:
  // the connections are read-only — we only run `cat <hostPath>` to capture
  // the current content for the diff.
  const serverGroups = new Map<string, Pair[]>();
  for (const p of pairs) {
    if (!serverGroups.has(p.server.id)) serverGroups.set(p.server.id, []);
    serverGroups.get(p.server.id)!.push(p);
  }

  for (const [, group] of serverGroups) {
    const server = group[0].server;
    const warnings: string[] = [];

    // Resolve secrets once per environment so we can both substitute and
    // redact in the rendered output (the redacted form is what we show in the
    // diff to avoid leaking secret values in dry-run responses).
    const secretValues = Object.values(await getSecretsForEnv(server.environmentId));

    const { client, error: clientError } = await createClientForServer(
      server.hostname,
      server.environmentId,
      getEnvironmentSshKey,
      { serverType: server.serverType }
    );

    if (!client) {
      for (const p of group) {
        results.push({
          serverName: server.name,
          serviceName: p.serviceName,
          configFileName: configFile.name,
          hostPath: p.sf.targetPath,
          diff: '',
          exists: false,
          referencingServices: [p.serviceName],
          warnings: [clientError || 'Failed to create SSH client'],
        });
      }
      continue;
    }

    try {
      await client.connect();

      for (const p of group) {
        const targetPath = p.sf.targetPath;
        const referencingServices = await listReferencingServiceNames(configFile.id, server.id);

        if (configFile.isBinary) {
          // No meaningful line diff for binary blobs — surface the size and a
          // warning so the caller knows a sync would still write the file.
          results.push({
            serverName: server.name,
            serviceName: p.serviceName,
            configFileName: configFile.name,
            hostPath: targetPath,
            diff: '',
            exists: false,
            referencingServices,
            warnings: ['Binary file — diff omitted'],
          });
          continue;
        }

        const composedSource = composeFragmentedContent(
          configFile.includedFragments.map((f) => ({
            name: f.fragment.name,
            content: f.fragment.content,
          })),
          configFile.content,
          configFile.language,
        );
        const { content: rawContent, missing, templateErrors } = await resolveSecretPlaceholders(
          server.environmentId,
          composedSource
        );
        const localWarnings: string[] = [];
        // Mirror the live path (`syncConfigFileToAttachedServices`) which
        // treats template errors and missing secrets as hard failures
        // (`success: false, error: '...'`). The dry-run keeps the warning
        // for back-compat but ALSO surfaces a structured `error` so callers
        // don't render a green diff for a sync that the live path would
        // refuse to perform.
        let hardError: string | null = null;
        if (templateErrors.length > 0) {
          const msg = `Template errors: ${templateErrors.join('; ')}`;
          localWarnings.push(msg);
          hardError = msg;
        }
        if (missing.length > 0) {
          const msg = `Missing secrets: ${missing.join(', ')}`;
          localWarnings.push(msg);
          hardError = hardError ? `${hardError}; ${msg}` : msg;
        }

        if (hardError) {
          // Skip the SSH `cat` + diff computation: the live path wouldn't
          // write to this target at all, so there's no meaningful diff to
          // compute. The result row still carries `referencingServices` and
          // the warnings so operators can see what's broken.
          results.push({
            serverName: server.name,
            serviceName: p.serviceName,
            configFileName: configFile.name,
            hostPath: targetPath,
            diff: '',
            exists: false,
            referencingServices,
            warnings: [...warnings, ...localWarnings],
            error: hardError,
          });
          continue;
        }

        const renderedContent = redactSecretValues(rawContent.trimEnd(), secretValues);

        // Read the current host file (best-effort). Use `cat` and check the
        // exit code so a missing file shows up as an empty `before`.
        // shellEscape() is mandatory here — the target path is user-supplied.
        let currentContent = '';
        let exists = false;
        try {
          const { stdout, code } = await client.exec(`cat ${shellEscape(targetPath)} 2>/dev/null`);
          if (code === 0) {
            currentContent = redactSecretValues(stdout.replace(/\n$/, ''), secretValues);
            exists = true;
          }
        } catch (err) {
          localWarnings.push(`Could not read host file: ${err instanceof Error ? err.message : String(err)}`);
        }

        const diff = unifiedDiff(currentContent, renderedContent, {
          fromLabel: `a${targetPath}`,
          toLabel: `b${targetPath}`,
        });

        results.push({
          serverName: server.name,
          serviceName: p.serviceName,
          configFileName: configFile.name,
          hostPath: targetPath,
          diff,
          exists,
          referencingServices,
          warnings: [...warnings, ...localWarnings],
        });
      }
    } catch (err) {
      for (const p of group) {
        results.push({
          serverName: server.name,
          serviceName: p.serviceName,
          configFileName: configFile.name,
          hostPath: p.sf.targetPath,
          diff: '',
          exists: false,
          referencingServices: [p.serviceName],
          warnings: [err instanceof Error ? err.message : String(err)],
        });
      }
    } finally {
      client.disconnect();
    }
  }

  return { dryRun: true, results };
}

/**
 * List the names of services that reference a given ConfigFile on a given
 * server (via their ServiceDeployment). Used by the dry-run sync preview so
 * callers see the blast radius of a single config-file change.
 */
export async function listReferencingServiceNames(configFileId: string, serverId: string): Promise<string[]> {
  const rows = await prisma.serviceFile.findMany({
    where: {
      configFileId,
      OR: [
        { serviceDeployment: { serverId } },
        // base rows (no serviceDeploymentId) attach to every deployment of the
        // service on this server.
        {
          serviceDeploymentId: null,
          service: { serviceDeployments: { some: { serverId } } },
        },
      ],
    },
    include: { service: { select: { name: true } } },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.service?.name) seen.add(r.service.name);
  }
  return [...seen].sort();
}

/**
 * Fire-and-forget: re-sync every ConfigFile that includes the given fragment
 * and has `autoResync = true`. Editing a fragment is equivalent in effect to
 * editing every including ConfigFile, so we fan out the sync through the same
 * code path used by direct ConfigFile edits.
 *
 * Audit rows are written per-ConfigFile with `autoTriggered = true` and a
 * `triggeredByFragmentId` discriminator so operators can see why a sync
 * happened. SSH / per-file failures are logged via `console.error` but never
 * thrown — callers `void`-call this.
 */
export async function triggerAutoResyncForFragment(
  fragmentId: string,
  fragmentName: string,
  actor?: AutoResyncActor,
): Promise<void> {
  try {
    const rows = await prisma.configFileFragment.findMany({
      where: { fragmentId, configFile: { autoResync: true, isBinary: false } },
      select: { configFileId: true, configFile: { select: { id: true, name: true } } },
    });

    if (rows.length === 0) return;

    await Promise.allSettled(
      rows.map(async (row) => {
        try {
          const outcome = await syncConfigFileToAttachedServices(row.configFileId);
          if (!outcome || outcome.status === 'no_targets') return;

          await logAudit({
            ...(actor ?? {}),
            action: 'sync_files',
            resourceType: 'config_file',
            resourceId: row.configFileId,
            resourceName: outcome.configFileName,
            details: {
              results: outcome.results,
              allSuccess: outcome.success,
              syncedTo: outcome.results.length,
              autoTriggered: true,
              triggeredBy: `fragment:${fragmentName}`,
              triggeredByFragmentId: fragmentId,
            },
            success: outcome.success,
            environmentId: outcome.environmentId,
          });
        } catch (err) {
          console.error(
            `[auto-resync] failed for configFile=${row.configFileId} (${row.configFile.name}) fragment=${fragmentName}:`,
            err
          );
        }
      })
    );
  } catch (err) {
    console.error(
      `[auto-resync] top-level failure for fragment=${fragmentId} (${fragmentName}):`,
      err
    );
  }
}

/**
 * Fire-and-forget: re-sync every ConfigFile in `environmentId` that has
 * `autoResync = true`, is text (not binary), and whose stored content
 * references `${key}`.
 *
 * Each ConfigFile is synced exactly once per call (cycle protection is naturally
 * one-per-row, not per occurrence). Each triggered sync writes an audit log
 * with `details.triggeredBy` + `details.autoTriggered = true`. SSH or per-file
 * failures are logged via `console.error` and do not abort the rest.
 *
 * Callers typically `void`-call this; it never throws.
 */
export async function triggerAutoResyncForKey(
  environmentId: string,
  key: string,
  triggeredBy: string,
  actor?: AutoResyncActor,
): Promise<void> {
  try {
    // ${KEY} placeholder - binary files don't get substitution and are skipped
    // (see config-files route: only the text branch calls resolveSecretPlaceholders).
    const placeholder = '${' + key + '}';

    // SQL LIKE coarse-filter for indexing performance. We still post-filter in JS
    // because SQLite's LIKE treats `_` as a single-char wildcard, and Prisma does
    // NOT escape it. Without the JS filter, triggering for key `FOO_BAR` would
    // also match a file containing `${FOOXBAR}` since `_` matches any char.
    //
    // Two match paths now (post-#115):
    //   1. The placeholder lives in the ConfigFile's own content.
    //   2. The placeholder lives in any included fragment's content (which is
    //      concatenated before the own content at render time).
    // A `${KEY}` reference that only appears in a fragment must still trigger
    // the cascade, otherwise editing a secret won't re-sync files that pulled
    // it in via a shared fragment.
    const rawCandidates = await prisma.configFile.findMany({
      where: {
        environmentId,
        autoResync: true,
        isBinary: false,
        OR: [
          { content: { contains: placeholder } },
          {
            includedFragments: {
              some: { fragment: { content: { contains: placeholder } } },
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        content: true,
        includedFragments: {
          select: { fragment: { select: { content: true } } },
        },
      },
    });

    // Post-filter to defeat SQLite LIKE's `_`-wildcard false positives — both
    // for the own-content branch and the fragment branch.
    const candidates = rawCandidates.filter(
      (cf) =>
        cf.content.includes(placeholder) ||
        cf.includedFragments.some((row) => row.fragment.content.includes(placeholder))
    );

    if (candidates.length === 0) return;

    await Promise.allSettled(
      candidates.map(async (cf) => {
        try {
          const outcome = await syncConfigFileToAttachedServices(cf.id);
          // Skip null (config file vanished) and no_targets (orphan — not
          // attached to any service/deployment). Writing an audit row for the
          // latter would record a spurious `success:false` event for an
          // operation that never had anything to do.
          if (!outcome || outcome.status === 'no_targets') return;

          await logAudit({
            ...(actor ?? {}),
            action: 'sync_files',
            resourceType: 'config_file',
            resourceId: cf.id,
            resourceName: outcome.configFileName,
            details: {
              results: outcome.results,
              allSuccess: outcome.success,
              syncedTo: outcome.results.length,
              autoTriggered: true,
              triggeredBy,
            },
            success: outcome.success,
            environmentId: outcome.environmentId,
          });
        } catch (err) {
          // Background task: never throw out. One bad config file shouldn't
          // abort the rest of the keys.
          console.error(
            `[auto-resync] failed for configFile=${cf.id} (${cf.name}) trigger=${triggeredBy}:`,
            err
          );
        }
      })
    );
  } catch (err) {
    console.error(
      `[auto-resync] top-level failure for env=${environmentId} key=${key} trigger=${triggeredBy}:`,
      err
    );
  }
}
