import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';

export interface ServerMetricsData {
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  diskUsedGb?: number;
  diskTotalGb?: number;
  loadAvg1?: number;
  loadAvg5?: number;
  loadAvg15?: number;
  uptime?: number;
}

export interface ServiceMetricsData {
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryLimitMb?: number;
  networkRxMb?: number;
  networkTxMb?: number;
  blockReadMb?: number;
  blockWriteMb?: number;
  restartCount?: number;
}

export async function collectServerMetricsSSH(serverId: string): Promise<ServerMetricsData | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) return null;

  // Create appropriate client based on hostname
  let client: CommandClient;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) return null;
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  try {
    await client.connect();

    const metrics: ServerMetricsData = {};

    // CPU usage - using top in batch mode
    const cpuResult = await client.exec("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'");
    if (cpuResult.code === 0 && cpuResult.stdout) {
      const cpuValue = parseFloat(cpuResult.stdout.trim());
      if (!isNaN(cpuValue)) {
        metrics.cpuPercent = cpuValue;
      }
    }

    // Memory - using free
    const memResult = await client.exec("free -m | awk '/^Mem:/ {print $2, $3}'");
    if (memResult.code === 0 && memResult.stdout) {
      const [total, used] = memResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(total) && !isNaN(used)) {
        metrics.memoryTotalMb = total;
        metrics.memoryUsedMb = used;
      }
    }

    // Disk - using df
    const diskResult = await client.exec("df -BG / | awk 'NR==2 {gsub(/G/,\"\"); print $2, $3}'");
    if (diskResult.code === 0 && diskResult.stdout) {
      const [total, used] = diskResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(total) && !isNaN(used)) {
        metrics.diskTotalGb = total;
        metrics.diskUsedGb = used;
      }
    }

    // Load average
    const loadResult = await client.exec("cat /proc/loadavg | awk '{print $1, $2, $3}'");
    if (loadResult.code === 0 && loadResult.stdout) {
      const [load1, load5, load15] = loadResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(load1)) metrics.loadAvg1 = load1;
      if (!isNaN(load5)) metrics.loadAvg5 = load5;
      if (!isNaN(load15)) metrics.loadAvg15 = load15;
    }

    // Uptime in seconds
    const uptimeResult = await client.exec("cat /proc/uptime | awk '{print int($1)}'");
    if (uptimeResult.code === 0 && uptimeResult.stdout) {
      const uptime = parseInt(uptimeResult.stdout.trim());
      if (!isNaN(uptime)) {
        metrics.uptime = uptime;
      }
    }

    return metrics;
  } catch (error) {
    console.error(`Failed to collect metrics for server ${serverId}:`, error);
    return null;
  } finally {
    client.disconnect();
  }
}

export async function collectServiceMetrics(
  serverId: string,
  containerName: string
): Promise<ServiceMetricsData | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) return null;

  // Create appropriate client based on hostname
  let client: CommandClient;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) return null;
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  try {
    await client.connect();

    const metrics: ServiceMetricsData = {};

    // Docker stats for container
    const statsResult = await client.exec(
      `docker stats --no-stream --format '{{json .}}' ${containerName} 2>/dev/null`
    );

    if (statsResult.code === 0 && statsResult.stdout) {
      try {
        const stats = JSON.parse(statsResult.stdout.trim());

        // CPU percentage (comes as "0.00%")
        if (stats.CPUPerc) {
          const cpu = parseFloat(stats.CPUPerc.replace('%', ''));
          if (!isNaN(cpu)) metrics.cpuPercent = cpu;
        }

        // Memory usage (comes as "100MiB / 1GiB")
        if (stats.MemUsage) {
          const memMatch = stats.MemUsage.match(/([\d.]+)([KMG]i?B)\s*\/\s*([\d.]+)([KMG]i?B)/i);
          if (memMatch) {
            const [, usedVal, usedUnit, limitVal, limitUnit] = memMatch;
            metrics.memoryUsedMb = convertToMb(parseFloat(usedVal), usedUnit);
            metrics.memoryLimitMb = convertToMb(parseFloat(limitVal), limitUnit);
          }
        }

        // Network I/O (comes as "1.5kB / 2.3kB")
        if (stats.NetIO) {
          const netMatch = stats.NetIO.match(/([\d.]+)([KMG]?B)\s*\/\s*([\d.]+)([KMG]?B)/i);
          if (netMatch) {
            const [, rxVal, rxUnit, txVal, txUnit] = netMatch;
            metrics.networkRxMb = convertToMb(parseFloat(rxVal), rxUnit);
            metrics.networkTxMb = convertToMb(parseFloat(txVal), txUnit);
          }
        }

        // Block I/O
        if (stats.BlockIO) {
          const blockMatch = stats.BlockIO.match(/([\d.]+)([KMG]?B)\s*\/\s*([\d.]+)([KMG]?B)/i);
          if (blockMatch) {
            const [, readVal, readUnit, writeVal, writeUnit] = blockMatch;
            metrics.blockReadMb = convertToMb(parseFloat(readVal), readUnit);
            metrics.blockWriteMb = convertToMb(parseFloat(writeVal), writeUnit);
          }
        }
      } catch {
        // JSON parse failed
      }
    }

    // Get restart count
    const inspectResult = await client.exec(
      `docker inspect --format '{{.RestartCount}}' ${containerName} 2>/dev/null`
    );
    if (inspectResult.code === 0 && inspectResult.stdout) {
      const restarts = parseInt(inspectResult.stdout.trim());
      if (!isNaN(restarts)) {
        metrics.restartCount = restarts;
      }
    }

    return metrics;
  } catch (error) {
    console.error(`Failed to collect metrics for container ${containerName}:`, error);
    return null;
  } finally {
    client.disconnect();
  }
}

function convertToMb(value: number, unit: string): number {
  const unitLower = unit.toLowerCase();
  if (unitLower.includes('g')) return value * 1024;
  if (unitLower.includes('k')) return value / 1024;
  if (unitLower.includes('b') && !unitLower.includes('k') && !unitLower.includes('m') && !unitLower.includes('g')) {
    return value / (1024 * 1024);
  }
  return value; // Already MB
}

export async function saveServerMetrics(
  serverId: string,
  metrics: ServerMetricsData,
  source: 'ssh' | 'agent'
): Promise<void> {
  await prisma.serverMetrics.create({
    data: {
      serverId,
      source,
      ...metrics,
    },
  });
}

export async function saveServiceMetrics(
  serviceId: string,
  metrics: ServiceMetricsData
): Promise<void> {
  await prisma.serviceMetrics.create({
    data: {
      serviceId,
      ...metrics,
    },
  });
}

export async function getServerMetrics(
  serverId: string,
  from?: Date,
  to?: Date,
  limit: number = 100
) {
  return prisma.serverMetrics.findMany({
    where: {
      serverId,
      collectedAt: {
        ...(from && { gte: from }),
        ...(to && { lte: to }),
      },
    },
    orderBy: { collectedAt: 'desc' },
    take: limit,
  });
}

export async function getServiceMetrics(
  serviceId: string,
  from?: Date,
  to?: Date,
  limit: number = 100
) {
  return prisma.serviceMetrics.findMany({
    where: {
      serviceId,
      collectedAt: {
        ...(from && { gte: from }),
        ...(to && { lte: to }),
      },
    },
    orderBy: { collectedAt: 'desc' },
    take: limit,
  });
}

export async function cleanupOldMetrics(retentionDays: number = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const serverResult = await prisma.serverMetrics.deleteMany({
    where: { collectedAt: { lt: cutoff } },
  });

  const serviceResult = await prisma.serviceMetrics.deleteMany({
    where: { collectedAt: { lt: cutoff } },
  });

  return serverResult.count + serviceResult.count;
}

export async function getEnvironmentMetricsSummary(environmentId: string) {
  const servers = await prisma.server.findMany({
    where: { environmentId },
    include: {
      metrics: {
        orderBy: { collectedAt: 'desc' },
        take: 1,
      },
      services: {
        include: {
          metrics: {
            orderBy: { collectedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    metricsMode: server.metricsMode,
    latestMetrics: server.metrics[0] || null,
    services: server.services.map((service) => ({
      id: service.id,
      name: service.name,
      containerName: service.containerName,
      latestMetrics: service.metrics[0] || null,
    })),
  }));
}
