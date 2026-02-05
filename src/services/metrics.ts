import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { determineHealthStatus, determineOverallStatus, type UrlHealthResult } from './servers.js';

export interface ServerMetricsData {
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  diskUsedGb?: number;
  diskTotalGb?: number;
  loadAvg1?: number;
  loadAvg5?: number;
  loadAvg15?: number;
  uptime?: number;
  openFds?: number;
  maxFds?: number;
  tcpEstablished?: number;
  tcpListen?: number;
  tcpTimeWait?: number;
  tcpCloseWait?: number;
  tcpTotal?: number;
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
    tags: server.tags,
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

export interface ServiceHealthData {
  containerName: string;
  metrics: ServiceMetricsData | null;
  containerStatus: string;
  healthStatus: string;
  overallStatus: string;
}

export interface CombinedServerData {
  serverMetrics: ServerMetricsData | null;
  serverHealth: { status: 'healthy' | 'unhealthy' };
  serviceData: ServiceHealthData[];
}

/**
 * Collect all server data (metrics + health) in a single SSH session.
 * This reduces duplicate SSH connections for SSH-mode servers.
 */
export async function collectServerDataSSH(serverId: string): Promise<CombinedServerData | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: {
      environment: true,
      services: {
        where: { discoveryStatus: 'found' },
        select: { id: true, containerName: true, healthCheckUrl: true },
      },
    },
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

  const docker = new DockerSSH(client);

  try {
    await client.connect();

    // Server is healthy if we can connect
    const serverHealth: { status: 'healthy' | 'unhealthy' } = { status: 'healthy' };

    // Collect server metrics
    const serverMetrics: ServerMetricsData = {};

    // CPU usage
    const cpuResult = await client.exec("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'");
    if (cpuResult.code === 0 && cpuResult.stdout) {
      const cpuValue = parseFloat(cpuResult.stdout.trim());
      if (!isNaN(cpuValue)) {
        serverMetrics.cpuPercent = cpuValue;
      }
    }

    // Memory
    const memResult = await client.exec("free -m | awk '/^Mem:/ {print $2, $3}'");
    if (memResult.code === 0 && memResult.stdout) {
      const [total, used] = memResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(total) && !isNaN(used)) {
        serverMetrics.memoryTotalMb = total;
        serverMetrics.memoryUsedMb = used;
      }
    }

    // Disk
    const diskResult = await client.exec("df -BG / | awk 'NR==2 {gsub(/G/,\"\"); print $2, $3}'");
    if (diskResult.code === 0 && diskResult.stdout) {
      const [total, used] = diskResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(total) && !isNaN(used)) {
        serverMetrics.diskTotalGb = total;
        serverMetrics.diskUsedGb = used;
      }
    }

    // Load average
    const loadResult = await client.exec("cat /proc/loadavg | awk '{print $1, $2, $3}'");
    if (loadResult.code === 0 && loadResult.stdout) {
      const [load1, load5, load15] = loadResult.stdout.trim().split(/\s+/).map(Number);
      if (!isNaN(load1)) serverMetrics.loadAvg1 = load1;
      if (!isNaN(load5)) serverMetrics.loadAvg5 = load5;
      if (!isNaN(load15)) serverMetrics.loadAvg15 = load15;
    }

    // Uptime
    const uptimeResult = await client.exec("cat /proc/uptime | awk '{print int($1)}'");
    if (uptimeResult.code === 0 && uptimeResult.stdout) {
      const uptime = parseInt(uptimeResult.stdout.trim());
      if (!isNaN(uptime)) {
        serverMetrics.uptime = uptime;
      }
    }

    // Collect service metrics and health for all containers
    const serviceData: ServiceHealthData[] = [];

    for (const service of server.services) {
      const metrics: ServiceMetricsData = {};

      // Get container health status
      const containerHealth = await docker.getContainerHealth(service.containerName);

      // Check URL health if configured
      let urlHealth: UrlHealthResult | null = null;
      if (service.healthCheckUrl) {
        urlHealth = await docker.checkUrl(service.healthCheckUrl);
      }

      // Get container stats
      const statsResult = await client.exec(
        `docker stats --no-stream --format '{{json .}}' ${service.containerName} 2>/dev/null`
      );

      if (statsResult.code === 0 && statsResult.stdout) {
        try {
          const stats = JSON.parse(statsResult.stdout.trim());

          if (stats.CPUPerc) {
            const cpu = parseFloat(stats.CPUPerc.replace('%', ''));
            if (!isNaN(cpu)) metrics.cpuPercent = cpu;
          }

          if (stats.MemUsage) {
            const memMatch = stats.MemUsage.match(/([\d.]+)([KMG]i?B)\s*\/\s*([\d.]+)([KMG]i?B)/i);
            if (memMatch) {
              const [, usedVal, usedUnit, limitVal, limitUnit] = memMatch;
              metrics.memoryUsedMb = convertToMb(parseFloat(usedVal), usedUnit);
              metrics.memoryLimitMb = convertToMb(parseFloat(limitVal), limitUnit);
            }
          }

          if (stats.NetIO) {
            const netMatch = stats.NetIO.match(/([\d.]+)([KMG]?B)\s*\/\s*([\d.]+)([KMG]?B)/i);
            if (netMatch) {
              const [, rxVal, rxUnit, txVal, txUnit] = netMatch;
              metrics.networkRxMb = convertToMb(parseFloat(rxVal), rxUnit);
              metrics.networkTxMb = convertToMb(parseFloat(txVal), txUnit);
            }
          }

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
        `docker inspect --format '{{.RestartCount}}' ${service.containerName} 2>/dev/null`
      );
      if (inspectResult.code === 0 && inspectResult.stdout) {
        const restarts = parseInt(inspectResult.stdout.trim());
        if (!isNaN(restarts)) {
          metrics.restartCount = restarts;
        }
      }

      // Determine health and overall status
      const healthStatus = determineHealthStatus(containerHealth.health, containerHealth.running, urlHealth);
      const overallStatus = determineOverallStatus(containerHealth.state, containerHealth.running, healthStatus);

      serviceData.push({
        containerName: service.containerName,
        metrics: Object.keys(metrics).length > 0 ? metrics : null,
        containerStatus: containerHealth.state,
        healthStatus,
        overallStatus,
      });
    }

    return {
      serverMetrics: Object.keys(serverMetrics).length > 0 ? serverMetrics : null,
      serverHealth,
      serviceData,
    };
  } catch (error) {
    console.error(`Failed to collect combined data for server ${serverId}:`, error);
    // Connection failure means server is unhealthy
    return {
      serverMetrics: null,
      serverHealth: { status: 'unhealthy' },
      serviceData: [],
    };
  } finally {
    client.disconnect();
  }
}
