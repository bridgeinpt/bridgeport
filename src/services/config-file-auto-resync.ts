import { prisma } from '../lib/db.js';
import { createClientForServer, shellEscape } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { resolveSecretPlaceholders } from './secrets.js';
import { logAudit } from './audit.js';

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
export async function syncConfigFileToAttachedServices(
  configFileId: string
): Promise<{ results: AutoResyncResult[]; success: boolean; configFileName: string; environmentId: string } | null> {
  const configFile = await prisma.configFile.findUnique({
    where: { id: configFileId },
    include: {
      services: {
        include: {
          service: { include: { serviceDeployments: { include: { server: true } } } },
          serviceDeployment: { include: { server: true } },
        },
      },
    },
  });

  if (!configFile || configFile.services.length === 0) {
    return null;
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
            const { content: rawContent, missing } = await resolveSecretPlaceholders(
              server.environmentId,
              configFile.content
            );
            const resolvedContent = rawContent.trimEnd();

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

  const success = results.length > 0 && results.every((r) => r.success);

  return {
    results,
    success,
    configFileName: configFile.name,
    environmentId: configFile.environmentId,
  };
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
    const rawCandidates = await prisma.configFile.findMany({
      where: {
        environmentId,
        autoResync: true,
        isBinary: false,
        content: { contains: placeholder },
      },
      select: { id: true, name: true, content: true },
    });

    const candidates = rawCandidates.filter((cf) => cf.content.includes(placeholder));

    if (candidates.length === 0) return;

    await Promise.allSettled(
      candidates.map(async (cf) => {
        try {
          const outcome = await syncConfigFileToAttachedServices(cf.id);
          if (!outcome) return; // Not attached to anything - nothing to do.

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
