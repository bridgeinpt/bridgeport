/**
 * Stress-test runner.
 *
 * Boots the test app on a real port, seeds enough Servers/Services/Metrics
 * to make the per-entity history endpoints work hard, then drives them
 * with autocannon. The script:
 *
 *   1. compares results against `thresholds.json`
 *   2. writes a machine-readable report to `stress-report.json`
 *   3. prints a human summary to stdout
 *   4. exits non-zero on any threshold violation
 *
 * It runs against an in-process Fastify instance (no external service),
 * which is what we want for CI: deterministic, no flaky network, and the
 * only variable left is the database query cost.
 *
 * Env vars must be set BEFORE any app modules load (Zod env validation
 * runs at import time), so this file uses dynamic imports throughout.
 */

// Pre-test env. setup.ts is only loaded under vitest, so wire it ourselves.
// Using a local file keeps the production DB untouched.
process.env.MASTER_KEY ??= 'ilyS3JROhJmj8QEYHuoZts8aoK2LG9SHl0EgIn0gsVw=';
process.env.JWT_SECRET ??= 'stress-jwt-secret';
process.env.NODE_ENV ??= 'test';
process.env.SCHEDULER_ENABLED ??= 'false';
process.env.PLUGINS_DIR ??= './plugins';
process.env.UPLOAD_DIR ??= './stress-uploads';
process.env.DATABASE_URL ??= 'file:./stress.db';

import { createRequire } from 'module';
import { writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const autocannon = require('autocannon') as (opts: AutocannonOpts) => Promise<AutocannonResult>;

interface AutocannonOpts {
  url: string;
  connections: number;
  duration: number;
  pipelining?: number;
  headers?: Record<string, string>;
  title?: string;
}

interface AutocannonResult {
  requests: { average: number; total: number };
  latency: { p50: number; p90: number; p95: number; p97_5: number; p99: number; average: number; max: number };
  errors: number;
  timeouts: number;
  non2xx: number;
  duration: number;
  title?: string;
}

interface ScenarioConfig {
  path: string;
  maxP99Ms: number;
  minRps: number;
}

interface ThresholdsFile {
  scenarios: Record<string, ScenarioConfig>;
  load: { connections: number; durationSec: number; pipelining?: number };
}

interface ScenarioReport {
  name: string;
  path: string;
  p50: number;
  p90: number;
  p99: number;
  rps: number;
  totalRequests: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  thresholds: { maxP99Ms: number; minRps: number };
  passed: boolean;
  failures: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const thresholdsPath = join(__dirname, 'thresholds.json');
const ciThresholdsPath = join(__dirname, 'thresholds.ci.json');
const reportPath = join(process.cwd(), 'stress-report.json');

/**
 * STRESS_CI=true picks `thresholds.ci.json`, which carries the looser
 * GitHub-hosted-runner targets. The local file stays tight so dev machines
 * notice regressions immediately; CI gets headroom for shared-runner noise.
 * Falls back to `thresholds.json` if the CI file is absent.
 */
function readThresholds(): ThresholdsFile {
  const useCi = process.env.STRESS_CI === 'true';
  if (useCi) {
    try {
      return require(ciThresholdsPath) as ThresholdsFile;
    } catch {
      // Fall through to the default file.
    }
  }
  return require(thresholdsPath) as ThresholdsFile;
}

function substitutePath(path: string, refs: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (m, key: string) => {
    const val = refs[key];
    if (!val) throw new Error(`Stress scenario path uses {${key}} but seed Refs has no such key`);
    return val;
  });
}

async function runScenario(
  name: string,
  scenario: ScenarioConfig,
  baseUrl: string,
  refs: Record<string, string>,
  authHeader: string,
  load: ThresholdsFile['load']
): Promise<ScenarioReport> {
  const path = substitutePath(scenario.path, refs);
  const result = await autocannon({
    url: `${baseUrl}${path}`,
    connections: load.connections,
    duration: load.durationSec,
    pipelining: load.pipelining ?? 1,
    headers: { authorization: authHeader },
    title: name,
  });

  const failures: string[] = [];
  if (result.non2xx > 0) failures.push(`non2xx=${result.non2xx}`);
  if (result.errors > 0) failures.push(`errors=${result.errors}`);
  if (result.timeouts > 0) failures.push(`timeouts=${result.timeouts}`);
  if (result.latency.p99 > scenario.maxP99Ms)
    failures.push(`p99=${result.latency.p99}ms > ${scenario.maxP99Ms}ms`);
  if (result.requests.average < scenario.minRps)
    failures.push(`rps=${result.requests.average.toFixed(1)} < ${scenario.minRps}`);

  return {
    name,
    path,
    p50: result.latency.p50,
    p90: result.latency.p90,
    p99: result.latency.p99,
    rps: result.requests.average,
    totalRequests: result.requests.total,
    non2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts,
    thresholds: { maxP99Ms: scenario.maxP99Ms, minRps: scenario.minRps },
    passed: failures.length === 0,
    failures,
  };
}

function formatRow(r: ScenarioReport): string {
  const status = r.passed ? 'PASS' : 'FAIL';
  return [
    `[${status}] ${r.name}`,
    `  path:           ${r.path}`,
    `  requests/s:     ${r.rps.toFixed(1)} (min ${r.thresholds.minRps})`,
    `  total:          ${r.totalRequests}`,
    `  p50/p90/p99:    ${r.p50}ms / ${r.p90}ms / ${r.p99}ms (max-p99 ${r.thresholds.maxP99Ms}ms)`,
    `  non2xx/errors:  ${r.non2xx} / ${r.errors}`,
    r.failures.length ? `  failures:       ${r.failures.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main(): Promise<number> {
  // Force a clean DB file — buildTestApp will (re)create the schema.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(`./stress.db${suffix}`, { force: true });
    } catch {
      // ignore
    }
  }

  // Dynamic imports so env vars are guaranteed to be set first.
  const [{ buildTestApp }, { generateTestToken }, { seedStressData, DEFAULT_SEED }] =
    await Promise.all([
      import('../helpers/app.js'),
      import('../helpers/auth.js'),
      import('./seed.js'),
    ]);

  const thresholds = readThresholds();
  const seed = {
    ...DEFAULT_SEED,
    ...(process.env.STRESS_SERVERS ? { servers: Number(process.env.STRESS_SERVERS) } : {}),
    ...(process.env.STRESS_SERVICES_PER_SERVER
      ? { servicesPerServer: Number(process.env.STRESS_SERVICES_PER_SERVER) }
      : {}),
    ...(process.env.STRESS_METRICS_PER_ENTITY
      ? { metricsPerEntity: Number(process.env.STRESS_METRICS_PER_ENTITY) }
      : {}),
  };

  console.log('▶ booting test app + seeding stress data', seed);
  const app = await buildTestApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind stress test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const refs = await seedStressData(app.prisma, seed);
    const token = await generateTestToken({ id: refs.userId, email: refs.userEmail });
    const authHeader = `Bearer ${token}`;

    // Warm-up so JIT/connection pool doesn't skew the first iteration.
    await autocannon({
      url: `${baseUrl}/health`,
      connections: 5,
      duration: 1,
    });

    const refsRecord = refs as unknown as Record<string, string>;
    // STRESS_SCENARIOS is a comma-separated allowlist used by the matrix
    // shards in stress.yml to parallelise the workflow. Unknown names abort
    // so a typo in the workflow YAML can't silently turn into "0 scenarios."
    const filter = (process.env.STRESS_SCENARIOS ?? '').trim();
    const allowedScenarios = filter
      ? new Set(filter.split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    if (allowedScenarios) {
      const known = new Set(Object.keys(thresholds.scenarios));
      const unknown = [...allowedScenarios].filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new Error(`STRESS_SCENARIOS lists unknown scenario(s): ${unknown.join(', ')}`);
      }
    }
    const reports: ScenarioReport[] = [];
    for (const [name, scenario] of Object.entries(thresholds.scenarios)) {
      if (allowedScenarios && !allowedScenarios.has(name)) continue;
      console.log(`\n▶ scenario: ${name}`);
      const r = await runScenario(
        name,
        scenario,
        baseUrl,
        refsRecord,
        authHeader,
        thresholds.load
      );
      console.log(formatRow(r));
      reports.push(r);
    }

    const soft = process.env.STRESS_SOFT === 'true';
    const summary = {
      generatedAt: new Date().toISOString(),
      seed,
      load: thresholds.load,
      scenarios: reports,
      passed: reports.every((r) => r.passed),
      soft,
    };
    writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    console.log(`\n▶ wrote ${reportPath}`);

    if (!summary.passed) {
      const verb = soft ? 'breached (soft mode — not failing the run)' : 'failed';
      console.error(`\n${soft ? 'ℹ️' : '✗'} stress thresholds ${verb}`);
      return soft ? 0 : 1;
    }
    console.log('\n✓ all stress thresholds passed');
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('stress runner crashed:', err);
    process.exit(2);
  });
