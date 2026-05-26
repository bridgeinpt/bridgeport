/**
 * Stress test seed.
 *
 * Populates a test database with enough Servers, Services, ServerMetrics
 * and ServiceMetrics to exercise the monitoring-history endpoints, which
 * were flagged by Sentry as the source of two N+1 patterns:
 *
 *   - BRIDGEPORT-BE-2: GET /api/environments/:envId/metrics/history          (per-server N+1)
 *   - BRIDGEPORT-BE-5: GET /api/environments/:envId/services/metrics/history (per-service N+1)
 *
 * The dataset is intentionally biased toward many servers/services rather
 * than a deep metric history — the bug is in the *number* of queries, not
 * in scanning a large table.
 */
import type { PrismaClient } from '@prisma/client';
import {
  createTestUser,
  createTestEnvironment,
  createTestServer,
  createTestContainerImage,
  createTestService,
} from '../factories/index.js';

export interface StressSeedOptions {
  /** Number of servers per environment (higher = larger N for ServerMetrics N+1). */
  servers: number;
  /** Services per server (servers × servicesPerServer = N for ServiceMetrics N+1). */
  servicesPerServer: number;
  /** Metric points per server/service. Small is fine — we exercise count, not depth. */
  metricsPerEntity: number;
  /** Minutes between metric points. */
  metricIntervalMin: number;
}

export const DEFAULT_SEED: StressSeedOptions = {
  servers: 30,
  servicesPerServer: 3,
  metricsPerEntity: 12,
  metricIntervalMin: 5,
};

export interface SeedResult {
  user: { id: string; email: string };
  environment: { id: string };
}

export async function seedStressData(
  prisma: PrismaClient,
  options: StressSeedOptions = DEFAULT_SEED
): Promise<SeedResult> {
  const user = await createTestUser(prisma, {
    email: 'stress@bridgeport.test',
    role: 'admin',
  });

  const env = await createTestEnvironment(prisma, { name: 'stress-env' });
  const image = await createTestContainerImage(prisma, { environmentId: env.id });

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
        serverId: server.id,
        containerImageId: image.id,
      });
      serviceIds.push(service.id);
    }
  }

  // Bulk-insert metrics with createMany — the seed itself shouldn't be slow.
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

  const serviceMetrics = serviceIds.flatMap((serviceId) =>
    Array.from({ length: options.metricsPerEntity }, (_, i) => ({
      serviceId,
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

  return {
    user: { id: user.id, email: user.email },
    environment: { id: env.id },
  };
}
