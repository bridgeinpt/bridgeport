import type { FastifyRequest } from 'fastify';

/**
 * Detect whether the caller is asking for a dry-run preview rather than a real
 * mutation. Supports two equivalent forms so REST and CLI clients can pick the
 * one that fits their tooling:
 *
 *  - Query param: `?dryRun=true`
 *  - Header:      `X-Dry-Run: true`
 *
 * Any other value (`false`, unset, empty) returns false. The check is strict on
 * the literal `"true"` so a typo or boolean coercion can't accidentally trigger
 * dry-run mode in production.
 */
export function isDryRun(request: FastifyRequest): boolean {
  const query = request.query as Record<string, unknown> | undefined;
  const headers = request.headers as Record<string, unknown> | undefined;

  if (query && typeof query.dryRun === 'string' && query.dryRun === 'true') {
    return true;
  }

  const headerValue = headers?.['x-dry-run'];
  if (typeof headerValue === 'string' && headerValue === 'true') {
    return true;
  }

  return false;
}

/**
 * Container action the real deploy would take given the resolved new digest.
 *
 *  - `start`: no running container exists — a fresh `compose up` would create one.
 *  - `cycle`: a running container exists with a different image digest — it would
 *             be recreated by `compose up` to pick up the new image.
 *  - `no-op`: a running container exists and is already on the resolved digest —
 *             the real deploy would still call `compose up`, but Docker would
 *             leave the container as-is.
 */
export type ContainerAction = 'start' | 'cycle' | 'no-op';

/**
 * Per-deployment dry-run report — what a real `POST /…/deploy` would do without
 * writing a Deployment row, touching the host filesystem, or calling
 * `docker compose up`.
 *
 * Secret values are redacted (`***`) in both `composeContent` and `env`.
 */
export interface DeployDryRunReport {
  dryRun: true;
  serviceId: string;
  serviceDeploymentId: string;
  serverName: string;
  imageTag: string;
  /**
   * Resolved manifest digest of `image:imageTag` from the registry. `null` when
   * the digest could not be resolved (no registry connection, manifest fetch
   * failed, etc.) — the real deploy would surface this at pull time.
   */
  imageDigest: string | null;
  /** Compose YAML that would be written to the host, with secrets redacted. */
  composeContent: string;
  /** Merged env (baseEnv + envOverrides) with secret values redacted. */
  env: Record<string, string>;
  containerAction: ContainerAction;
  /** Non-fatal issues surfaced during resolution (missing secrets, no digest, etc.). */
  warnings: string[];
}

/**
 * Plan dry-run envelope — one entry per ordered deploy step. Mirrors the
 * synchronous ordering `executePlan` would use.
 */
export interface PlanDryRunReport {
  dryRun: true;
  planId: string;
  planName: string;
  steps: Array<DeployDryRunReport & { stepOrder: number; serviceName: string }>;
}

/**
 * Per-target preview for a config-file sync dry-run.
 */
export interface ConfigSyncTarget {
  serverName: string;
  serviceName: string;
  configFileName: string;
  hostPath: string;
  /** Unified diff between current host contents and rendered (redacted) content. */
  diff: string;
  /** Whether the host file currently exists. */
  exists: boolean;
  /** Names of services that reference this config file on this server. */
  referencingServices: string[];
  /** Non-fatal issues (missing secrets, SSH error, etc.). */
  warnings: string[];
}

export interface ConfigSyncDryRunReport {
  dryRun: true;
  results: ConfigSyncTarget[];
}

/**
 * Redact secret values from a rendered string (compose content or env var).
 *
 * After secret substitution, the rendered text contains the secret VALUE
 * verbatim — leaking it in an API response would defeat the point of having
 * a secrets store. Replace every occurrence of each value with `***`.
 *
 * The function is order-independent: longest values are replaced first so a
 * value that is a substring of another doesn't truncate the longer one mid-way.
 * Empty values are skipped (otherwise `String.replaceAll('', '***')` injects
 * `***` between every character).
 */
export function redactSecretValues(
  content: string,
  secretValues: ReadonlyArray<string>
): string {
  if (!content) return content;
  const sorted = [...secretValues].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  let result = content;
  for (const value of sorted) {
    // Use split/join to avoid having to escape regex metacharacters in the secret.
    result = result.split(value).join('***');
  }
  return result;
}

/**
 * Redact secret values from a key/value env map. Values matching any secret are
 * replaced with `***`; placeholders left as-is so callers can still see which
 * keys reference which secrets.
 */
export function redactEnvSecrets(
  env: Record<string, string>,
  secretValues: ReadonlyArray<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = redactSecretValues(value, secretValues);
  }
  return result;
}

/**
 * Produce a minimal unified diff between two text blobs. Used by the
 * config-file dry-run to show what would change on the host file without
 * pulling in a heavyweight diff dependency.
 *
 * Format follows `diff -u` conventions enough that common diff viewers can
 * render it: `--- a`, `+++ b`, `@@ … @@`, leading `-`/`+`/` ` per line.
 *
 * Uses an O(N*M) LCS table so it handles small-to-moderate config files
 * (typical config files are well under a few thousand lines). Big binary files
 * are explicitly excluded earlier in the pipeline — they have no meaningful
 * line diff anyway.
 */
export function unifiedDiff(before: string, after: string, options: { fromLabel?: string; toLabel?: string } = {}): string {
  const fromLabel = options.fromLabel ?? 'current';
  const toLabel = options.toLabel ?? 'rendered';

  if (before === after) {
    return '';
  }

  const aLines = before.split('\n');
  const bLines = after.split('\n');
  const n = aLines.length;
  const m = bLines.length;

  // LCS length table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  type Op = { type: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ type: ' ', line: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: '-', line: aLines[i] });
      i++;
    } else {
      ops.push({ type: '+', line: bLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: '-', line: aLines[i++] });
  }
  while (j < m) {
    ops.push({ type: '+', line: bLines[j++] });
  }

  // Emit a single hunk covering the whole file. Real `diff -u` clusters hunks
  // by adjacency; for dry-run preview the whole-file form is plenty.
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`, `@@ -1,${n} +1,${m} @@`];
  for (const op of ops) {
    lines.push(`${op.type}${op.line}`);
  }
  return lines.join('\n');
}
