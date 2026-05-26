/**
 * Stress test seed.
 *
 * Populates a test database with enough data to exercise every read endpoint
 * we stress test. Returns a `Refs` object whose keys are referenced by
 * `thresholds.json` via `{placeholder}` substitution — that's how a scenario
 * URL like `/api/services/{serviceId}` finds a real service ID at runtime.
 *
 * The data shape is intentionally biased toward many entities (servers,
 * services, container images, secrets) rather than deep history — bugs of
 * the "fan-out one query per entity" shape live in the *count*, not the depth.
 */
import type { PrismaClient } from '@prisma/client';
import {
  createTestUser,
  createTestEnvironment,
  createTestServer,
  createTestContainerImage,
  createTestImageDigest,
  createTestService,
} from '../factories/index.js';

export interface StressSeedOptions {
  /** Number of servers per environment (drives N for ServerMetrics N+1). */
  servers: number;
  /** Services per server (servers × servicesPerServer = N for ServiceMetrics N+1). */
  servicesPerServer: number;
  /** Metric points per server/service. Small is fine — we exercise count, not depth. */
  metricsPerEntity: number;
  /** Minutes between metric points. */
  metricIntervalMin: number;
  /** Number of container images in the env. */
  containerImages: number;
  /** Digests per container image (drives N+1 patterns in image listing). */
  digestsPerImage: number;
  /** Secrets per environment (drives N+1 patterns in secrets listing). */
  secrets: number;
  /** Config files per environment — secrets list scans their content. */
  configFiles: number;
  /** Audit log rows per environment. */
  auditLogs: number;
  /** Health check log rows per resource (server + service). */
  healthLogsPerResource: number;
  /** Monitored databases per environment (drives database-metrics-history). */
  databases: number;
}

export const DEFAULT_SEED: StressSeedOptions = {
  servers: 30,
  servicesPerServer: 3,
  metricsPerEntity: 12,
  metricIntervalMin: 5,
  containerImages: 15,
  digestsPerImage: 4,
  secrets: 20,
  configFiles: 6,
  auditLogs: 200,
  healthLogsPerResource: 5,
  databases: 8,
};

/** IDs of seeded entities that scenarios can reference via {placeholder} in URLs. */
export interface Refs {
  envId: string;
  serverId: string;
  serviceId: string;
  containerImageId: string;
  secretId: string;
  configFileId: string;
  userId: string;
  userEmail: string;
}

const SECRET_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'SENTRY_DSN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'STRIPE_API_KEY',
  'SLACK_WEBHOOK',
  'GITHUB_TOKEN',
  'PUBLIC_API_URL',
];

function compose(env: string, vars: string[]): string {
  // A modestly-sized compose-style config file that references many secrets,
  // so the secrets/vars usage-scan has real work to do per render.
  const refs = vars.map((v, i) => `      - ${v}=\${${v}}\n      - APP_${i}_VAR=\$${v}`).join('\n');
  return [
    'version: "3.9"',
    'services:',
    `  app-${env}:`,
    '    image: registry.example.com/app:latest',
    '    environment:',
    refs,
    '    ports:',
    '      - "8080:8080"',
  ].join('\n');
}

export async function seedStressData(
  prisma: PrismaClient,
  options: StressSeedOptions = DEFAULT_SEED
): Promise<Refs> {
  const user = await createTestUser(prisma, {
    email: 'stress@bridgeport.test',
    role: 'admin',
  });

  const env = await createTestEnvironment(prisma, { name: 'stress-env' });

  // -- Container images + digests
  const imageIds: string[] = [];
  for (let i = 0; i < options.containerImages; i++) {
    const img = await createTestContainerImage(prisma, {
      environmentId: env.id,
      imageName: `registry.example.com/stress/app-${i}`,
    });
    imageIds.push(img.id);

    for (let d = 0; d < options.digestsPerImage; d++) {
      await createTestImageDigest(prisma, {
        containerImageId: img.id,
        manifestDigest: `sha256:${(i * 100 + d).toString().padStart(64, 'a')}`,
        tags: ['latest', `v1.${d}`],
      });
    }
  }
  const containerImageId = imageIds[0]!;

  // -- Servers + services
  const serverIds: string[] = [];
  const serviceIds: string[] = [];

  for (let s = 0; s < options.servers; s++) {
    const server = await createTestServer(prisma, {
      environmentId: env.id,
      metricsMode: 'agent',
      tags: ['stress', s % 2 === 0 ? 'tier:edge' : 'tier:core'],
    });
    serverIds.push(server.id);

    for (let svc = 0; svc < options.servicesPerServer; svc++) {
      const service = await createTestService(prisma, {
        environmentId: env.id,
        serverId: server.id,
        // Spread services across the seeded images so a `containerImageId`
        // lookup isn't skewed to one row.
        containerImageId: imageIds[(s * options.servicesPerServer + svc) % imageIds.length]!,
      });
      serviceIds.push(service.id);
    }
  }

  // Metrics are per-deployment in 2.0 — resolve the deployment ids the
  // factory created for each (service, server) pair so we can seed
  // ServiceMetrics.serviceDeploymentId below.
  const deployments = await prisma.serviceDeployment.findMany({
    where: { serviceId: { in: serviceIds } },
    select: { id: true },
  });
  const deploymentIds = deployments.map((d) => d.id);

  // -- Metrics (bulk-insert; the seed itself shouldn't be slow)
  const now = Date.now();
  const intervalMs = options.metricIntervalMin * 60 * 1000;

  const serverMetrics = serverIds.flatMap((serverId) =>
    Array.from({ length: options.metricsPerEntity }, (_, i) => ({
      serverId,
      collectedAt: new Date(now - (options.metricsPerEntity - 1 - i) * intervalMs),
      cpuPercent: 10 + (i % 50),
      memoryUsedMb: 1024 + i * 32,
      memoryTotalMb: 8192,
      swapUsedMb: 0,
      swapTotalMb: 2048,
      diskUsedGb: 20 + (i % 30),
      diskTotalGb: 100,
      loadAvg1: 0.5 + (i % 5) * 0.1,
      loadAvg5: 0.4,
      loadAvg15: 0.3,
      openFds: 200 + i,
      maxFds: 1024,
      tcpEstablished: 50,
      tcpListen: 20,
      tcpTimeWait: 10,
      tcpCloseWait: 1,
      tcpTotal: 81,
      source: 'agent',
    }))
  );

  const serviceMetrics = deploymentIds.flatMap((serviceDeploymentId) =>
    Array.from({ length: options.metricsPerEntity }, (_, i) => ({
      serviceDeploymentId,
      collectedAt: new Date(now - (options.metricsPerEntity - 1 - i) * intervalMs),
      cpuPercent: 5 + (i % 30),
      memoryUsedMb: 128 + i * 16,
      memoryLimitMb: 512,
      networkRxMb: 1.5 * i,
      networkTxMb: 0.8 * i,
      blockReadMb: 0,
      blockWriteMb: 0,
      restartCount: 0,
    }))
  );

  await prisma.serverMetrics.createMany({ data: serverMetrics });
  await prisma.serviceMetrics.createMany({ data: serviceMetrics });

  // -- Secrets (encrypted via the encryption layer would require initCrypto;
  // the routes only decrypt on /secrets/:id/value, not on the list path that
  // we stress test — so we can short-circuit with empty encrypted values).
  const secretKeys = Array.from({ length: options.secrets }, (_, i) =>
    i < SECRET_KEYS.length ? SECRET_KEYS[i]! : `SECRET_${i}`
  );
  await prisma.secret.createMany({
    data: secretKeys.map((key) => ({
      key,
      encryptedValue: 'stub-encrypted',
      nonce: 'stub-nonce',
      environmentId: env.id,
    })),
  });
  const firstSecret = await prisma.secret.findFirst({ where: { environmentId: env.id } });

  // -- Vars
  await prisma.var.createMany({
    data: secretKeys.slice(0, Math.min(10, options.secrets)).map((key) => ({
      key: `${key}_PUBLIC`,
      value: `value-of-${key}`,
      environmentId: env.id,
    })),
  });

  // -- Config files (their content references the seeded secrets, exercising
  // the secrets/vars usage-scan code path)
  const configFileIds: string[] = [];
  for (let i = 0; i < options.configFiles; i++) {
    const file = await prisma.configFile.create({
      data: {
        name: `stack-${i}`,
        filename: `docker-compose-${i}.yml`,
        content: compose(`stack${i}`, secretKeys.slice(0, 6)),
        environmentId: env.id,
      },
    });
    configFileIds.push(file.id);
  }

  // -- Audit logs
  if (options.auditLogs > 0) {
    const actions = ['create', 'update', 'delete', 'deploy', 'restart'];
    const resourceTypes = ['service', 'server', 'secret', 'config_file', 'environment'];
    await prisma.auditLog.createMany({
      data: Array.from({ length: options.auditLogs }, (_, i) => ({
        action: actions[i % actions.length]!,
        resourceType: resourceTypes[i % resourceTypes.length]!,
        resourceId: serviceIds[i % serviceIds.length]!,
        resourceName: `entity-${i}`,
        environmentId: env.id,
        userId: user.id,
        createdAt: new Date(now - i * 60_000),
      })),
    });
  }

  // -- Health check logs (per resource) — drives /health-status N+1
  if (options.healthLogsPerResource > 0) {
    const serverLogs = serverIds.flatMap((id, idx) =>
      Array.from({ length: options.healthLogsPerResource }, (_, j) => ({
        environmentId: env.id,
        resourceType: 'server',
        resourceId: id,
        resourceName: `server-${idx}`,
        checkType: 'ssh',
        status: j === 0 ? 'success' : (j % 3 === 0 ? 'failure' : 'success'),
        durationMs: 120 + j * 5,
        createdAt: new Date(now - j * 60_000),
      }))
    );
    const serviceLogs = deploymentIds.flatMap((id, idx) =>
      Array.from({ length: options.healthLogsPerResource }, (_, j) => ({
        environmentId: env.id,
        resourceType: 'service_deployment',
        resourceId: id,
        resourceName: `service-${idx}`,
        checkType: 'container_health',
        status: 'success',
        durationMs: 60 + j * 2,
        createdAt: new Date(now - j * 60_000),
      }))
    );
    await prisma.healthCheckLog.createMany({ data: [...serverLogs, ...serviceLogs] });
  }

  // -- Databases (drives /databases/metrics/history scenario for issue #139).
  // We need a DatabaseType with a `monitoringConfig.queries` array (the route
  // reads this to build queryMeta) and a small set of monitored databases
  // each with `metricsPerEntity` JSON metric points.
  if (options.databases > 0) {
    const monitoringConfig = JSON.stringify({
      queries: [
        { name: 'active_connections', displayName: 'Active Connections', resultType: 'scalar', unit: '' },
        { name: 'cache_hit_ratio', displayName: 'Cache Hit Ratio', resultType: 'scalar', unit: '%' },
        { name: 'database_size_bytes', displayName: 'Database Size', resultType: 'scalar', unit: 'bytes' },
        { name: 'transactions_per_sec', displayName: 'Transactions/sec', resultType: 'scalar', unit: '' },
      ],
    });
    const dbType = await prisma.databaseType.create({
      data: {
        name: `stress-postgres-${Date.now()}`,
        displayName: 'PostgreSQL (stress)',
        connectionFields: '[]',
        defaultPort: 5432,
        monitoringConfig,
      },
    });

    const dbIds: string[] = [];
    for (let i = 0; i < options.databases; i++) {
      const db = await prisma.database.create({
        data: {
          name: `stress-db-${i}`,
          type: 'postgres',
          databaseTypeId: dbType.id,
          environmentId: env.id,
          serverId: serverIds[i % serverIds.length]!,
          host: 'localhost',
          port: 5432,
          databaseName: `stressdb_${i}`,
          monitoringEnabled: true,
          monitoringStatus: 'connected',
        },
      });
      dbIds.push(db.id);
    }

    const dbMetrics = dbIds.flatMap((databaseId, dbIdx) =>
      Array.from({ length: options.metricsPerEntity }, (_, i) => ({
        databaseId,
        collectedAt: new Date(now - (options.metricsPerEntity - 1 - i) * intervalMs),
        metricsJson: JSON.stringify({
          active_connections: 10 + ((dbIdx + i) % 50),
          cache_hit_ratio: 95 + ((dbIdx + i) % 5) * 0.5,
          database_size_bytes: 100_000_000 + dbIdx * 1_000_000 + i * 1000,
          transactions_per_sec: 50 + ((dbIdx + i) % 200),
        }),
      }))
    );
    if (dbMetrics.length > 0) {
      await prisma.databaseMetrics.createMany({ data: dbMetrics });
    }
  }

  return {
    envId: env.id,
    serverId: serverIds[0]!,
    serviceId: serviceIds[0]!,
    containerImageId,
    secretId: firstSecret!.id,
    configFileId: configFileIds[0]!,
    userId: user.id,
    userEmail: user.email,
  };
}
