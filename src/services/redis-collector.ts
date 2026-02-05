import Redis, { Cluster } from 'ioredis';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
  isCluster?: boolean;
  clusterNodes?: string[];
}

export interface RedisMetrics {
  // Essential metrics
  hitRate: number | null;
  keyspaceHits: number;
  keyspaceMisses: number;
  usedMemoryBytes: number;
  maxMemoryBytes: number | null;
  memoryUsagePercent: number | null;
  evictedKeys: number;
  connectedClients: number;
  blockedClients: number;
  opsPerSec: number;

  // Performance metrics
  memFragmentationRatio: number | null;
  totalKeys: number;
  keysWithExpiry: number;
  avgTtlMs: number | null;
  usedCpuSys: number;
  usedCpuUser: number;
  rejectedConnections: number;

  // Persistence
  rdbLastSaveTime: string | null;
  rdbChangesPending: number;
  aofEnabled: boolean;
  aofCurrentSize: number | null;

  // Replication
  role: string;
  connectedSlaves: number;
  masterLinkStatus: string | null;
  replicationOffset: number | null;

  // Cluster info (if applicable)
  cluster?: {
    state: string;
    slotsAssigned: number;
    slotsOk: number;
    slotsPfail: number;
    slotsFail: number;
    knownNodes: number;
    clusterSize: number;
  };

  // Version info
  redisVersion: string;
  uptimeSeconds: number;
}

export interface RedisTestResult {
  success: boolean;
  message: string;
  details?: {
    version?: string;
    role?: string;
    connectedClients?: number;
    usedMemory?: string;
  };
}

export interface ClusterDiscoveryResult {
  isCluster: boolean;
  nodes?: string[];
  message: string;
}

function parseRedisInfo(info: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = info.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

function parseKeyspaceInfo(info: Record<string, string>): { totalKeys: number; keysWithExpiry: number } {
  let totalKeys = 0;
  let keysWithExpiry = 0;

  // Parse db0, db1, etc. entries like "db0:keys=1000,expires=500,avg_ttl=3600000"
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith('db') && /^db\d+$/.test(key)) {
      const match = value.match(/keys=(\d+),expires=(\d+)/);
      if (match) {
        totalKeys += parseInt(match[1]);
        keysWithExpiry += parseInt(match[2]);
      }
    }
  }

  return { totalKeys, keysWithExpiry };
}

export async function testRedisConnection(options: RedisConnectionOptions): Promise<RedisTestResult> {
  let client: Redis | Cluster | null = null;

  try {
    if (options.isCluster && options.clusterNodes && options.clusterNodes.length > 0) {
      const nodes = options.clusterNodes.map((node) => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port) || 6379 };
      });
      client = new Cluster(nodes, {
        redisOptions: {
          password: options.password,
          connectTimeout: 5000,
        },
      });
    } else {
      client = new Redis({
        host: options.host,
        port: options.port,
        password: options.password,
        db: options.db ?? 0,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Don't retry for connection test
      });
    }

    // Test connection with PING
    await client.ping();

    // Get basic info
    const info = await client.info();
    const parsed = parseRedisInfo(info);

    return {
      success: true,
      message: 'Connection successful',
      details: {
        version: parsed.redis_version,
        role: parsed.role,
        connectedClients: parseInt(parsed.connected_clients) || 0,
        usedMemory: parsed.used_memory_human,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Connection failed: ${message}`,
    };
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}

export async function collectRedisMetrics(options: RedisConnectionOptions): Promise<RedisMetrics> {
  let client: Redis | Cluster | null = null;

  try {
    if (options.isCluster && options.clusterNodes && options.clusterNodes.length > 0) {
      const nodes = options.clusterNodes.map((node) => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port) || 6379 };
      });
      client = new Cluster(nodes, {
        redisOptions: {
          password: options.password,
          connectTimeout: 10000,
        },
      });
    } else {
      client = new Redis({
        host: options.host,
        port: options.port,
        password: options.password,
        db: options.db ?? 0,
        connectTimeout: 10000,
        maxRetriesPerRequest: 3,
      });
    }

    // Get all info sections
    const info = await client.info();
    const parsed = parseRedisInfo(info);

    // Parse keyspace info
    const { totalKeys, keysWithExpiry } = parseKeyspaceInfo(parsed);

    // Calculate hit rate
    const hits = parseInt(parsed.keyspace_hits) || 0;
    const misses = parseInt(parsed.keyspace_misses) || 0;
    const hitRate = hits + misses > 0 ? hits / (hits + misses) : null;

    // Memory metrics
    const usedMemory = parseInt(parsed.used_memory) || 0;
    const maxMemory = parseInt(parsed.maxmemory) || null;
    const memoryUsagePercent = maxMemory && maxMemory > 0 ? (usedMemory / maxMemory) * 100 : null;

    // Parse RDB last save time
    const rdbLastSave = parseInt(parsed.rdb_last_save_time);
    const rdbLastSaveTime = rdbLastSave ? new Date(rdbLastSave * 1000).toISOString() : null;

    // Build metrics object
    const metrics: RedisMetrics = {
      // Essential
      hitRate,
      keyspaceHits: hits,
      keyspaceMisses: misses,
      usedMemoryBytes: usedMemory,
      maxMemoryBytes: maxMemory,
      memoryUsagePercent,
      evictedKeys: parseInt(parsed.evicted_keys) || 0,
      connectedClients: parseInt(parsed.connected_clients) || 0,
      blockedClients: parseInt(parsed.blocked_clients) || 0,
      opsPerSec: parseInt(parsed.instantaneous_ops_per_sec) || 0,

      // Performance
      memFragmentationRatio: parseFloat(parsed.mem_fragmentation_ratio) || null,
      totalKeys,
      keysWithExpiry,
      avgTtlMs: null, // Would need to sample keys to calculate
      usedCpuSys: parseFloat(parsed.used_cpu_sys) || 0,
      usedCpuUser: parseFloat(parsed.used_cpu_user) || 0,
      rejectedConnections: parseInt(parsed.rejected_connections) || 0,

      // Persistence
      rdbLastSaveTime,
      rdbChangesPending: parseInt(parsed.rdb_changes_since_last_save) || 0,
      aofEnabled: parsed.aof_enabled === '1',
      aofCurrentSize: parsed.aof_current_size ? parseInt(parsed.aof_current_size) : null,

      // Replication
      role: parsed.role || 'unknown',
      connectedSlaves: parseInt(parsed.connected_slaves) || 0,
      masterLinkStatus: parsed.master_link_status || null,
      replicationOffset: parsed.master_repl_offset
        ? parseInt(parsed.master_repl_offset)
        : parsed.slave_repl_offset
          ? parseInt(parsed.slave_repl_offset)
          : null,

      // Version info
      redisVersion: parsed.redis_version || 'unknown',
      uptimeSeconds: parseInt(parsed.uptime_in_seconds) || 0,
    };

    // Get cluster info if this is a cluster
    if (options.isCluster || parsed.cluster_enabled === '1') {
      try {
        const clusterInfo = await client.cluster('INFO') as string;
        const clusterParsed = parseRedisInfo(clusterInfo);

        metrics.cluster = {
          state: clusterParsed.cluster_state || 'unknown',
          slotsAssigned: parseInt(clusterParsed.cluster_slots_assigned) || 0,
          slotsOk: parseInt(clusterParsed.cluster_slots_ok) || 0,
          slotsPfail: parseInt(clusterParsed.cluster_slots_pfail) || 0,
          slotsFail: parseInt(clusterParsed.cluster_slots_fail) || 0,
          knownNodes: parseInt(clusterParsed.cluster_known_nodes) || 0,
          clusterSize: parseInt(clusterParsed.cluster_size) || 0,
        };
      } catch {
        // Cluster commands might fail on non-cluster instances
      }
    }

    return metrics;
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}

export async function discoverRedisCluster(options: {
  host: string;
  port: number;
  password?: string;
}): Promise<ClusterDiscoveryResult> {
  let client: Redis | null = null;

  try {
    client = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });

    // Check if cluster mode is enabled
    const info = await client.info('cluster');
    const parsed = parseRedisInfo(info);

    if (parsed.cluster_enabled !== '1') {
      return {
        isCluster: false,
        message: 'Redis is not running in cluster mode',
      };
    }

    // Get cluster nodes
    const nodesInfo = await client.cluster('NODES') as string;
    const nodes: string[] = [];

    const lines = nodesInfo.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(' ');
      if (parts.length >= 2) {
        // Format: <id> <ip:port@cport> <flags> <master> <ping-sent> <pong-recv> <config-epoch> <link-state> <slot> <slot> ...
        const address = parts[1].split('@')[0]; // Remove @cport part
        if (address && !address.startsWith(':')) {
          nodes.push(address);
        }
      }
    }

    return {
      isCluster: true,
      nodes,
      message: `Found ${nodes.length} cluster node(s)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      isCluster: false,
      message: `Cluster discovery failed: ${message}`,
    };
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}
