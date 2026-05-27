import type { ServerWithServices, Database, ServiceConnection, ExposedPort } from './api';
import { safeJsonParse } from './helpers';

export interface InferredConnection {
  sourceType: 'service' | 'database';
  sourceId: string;
  targetType: 'service' | 'database';
  targetId: string;
  port: number;
  protocol: string;
  label: string;
}

// Well-known port to database type mapping
const WELL_KNOWN_PORTS: Record<number, string> = {
  5432: 'postgresql',
  3306: 'mysql',
  6379: 'redis',
  27017: 'mongodb',
};

function parseExposedPorts(portsJson: string | null | undefined): ExposedPort[] {
  return safeJsonParse(portsJson ?? null, [] as ExposedPort[]);
}

/**
 * Infer connections between services and databases based on port matching.
 * Runs entirely on the frontend at render time.
 */
export function inferConnections(
  servers: ServerWithServices[],
  databases: Database[]
): InferredConnection[] {
  const connections: InferredConnection[] = [];
  const seen = new Set<string>();

  // Build database lookup: map of databaseId -> { db, serverId }
  const dbMap = new Map<string, Database>();
  for (const db of databases) {
    dbMap.set(db.id, db);
  }

  // Build server hostname/IP lookup
  const serverHostMap = new Map<string, string>(); // serverId -> hostname
  for (const server of servers) {
    serverHostMap.set(server.id, server.hostname);
  }

  for (const server of servers) {
    for (const service of server.services) {
      const ports = parseExposedPorts(service.exposedPorts);

      for (const port of ports) {
        const containerPort = port.container;

        for (const db of databases) {
          if (!db.port) continue;

          let matched = false;

          // Same server match: service and database on same server, container port matches db port
          if (db.serverId === server.id && containerPort === db.port) {
            matched = true;
          }

          // Cross-server match: database host matches service's server hostname/IP
          if (!matched && db.host && containerPort === db.port) {
            const serverHostname = serverHostMap.get(server.id);
            if (
              db.host === serverHostname ||
              db.host === server.publicIp ||
              db.host === 'localhost' ||
              db.host === '127.0.0.1'
            ) {
              matched = true;
            }
          }

          // Well-known port fallback: match container port to known db type
          if (!matched && containerPort in WELL_KNOWN_PORTS) {
            const expectedType = WELL_KNOWN_PORTS[containerPort];
            const dbTypeName = (db.databaseType?.name || db.type || '').toLowerCase();
            if (dbTypeName.includes(expectedType)) {
              matched = true;
            }
          }

          if (matched) {
            const key = `service:${service.id}->database:${db.id}:${containerPort}`;
            if (!seen.has(key)) {
              seen.add(key);
              connections.push({
                sourceType: 'service',
                sourceId: service.id,
                targetType: 'database',
                targetId: db.id,
                port: containerPort,
                protocol: 'tcp',
                label: `${db.databaseType?.displayName || db.type} :${containerPort}`,
              });
            }
          }
        }
      }
    }
  }

  return connections;
}

/**
 * Merge auto-inferred connections with manual connections into a unified edge list.
 * Returns edge descriptors for React Flow rendering.
 */
export interface TopologyEdge {
  id: string;
  source: string; // "service:<id>" or "database:<id>"
  sourceHandle?: string | null;
  target: string; // "service:<id>" or "database:<id>"
  targetHandle?: string | null;
  type: 'auto' | 'manual';
  directed: boolean;
  port?: number | null;
  protocol?: string | null;
  label?: string | null;
  // True when this edge's source/target were rewritten by collapse-aggregation
  // (so the inline X delete button should be suppressed even if the original
  // edge was a single manual connection).
  aggregated?: boolean;
}

export function mergeConnections(
  inferred: InferredConnection[],
  manual: ServiceConnection[]
): TopologyEdge[] {
  const edges: TopologyEdge[] = [];

  // Add auto-inferred edges
  for (const conn of inferred) {
    edges.push({
      id: `auto:${conn.sourceType}:${conn.sourceId}->${conn.targetType}:${conn.targetId}:${conn.port}`,
      source: `${conn.sourceType}:${conn.sourceId}`,
      target: `${conn.targetType}:${conn.targetId}`,
      type: 'auto',
      directed: true, // auto-inferred are always directed (service -> db)
      port: conn.port,
      protocol: conn.protocol,
      label: conn.label,
    });
  }

  // Add manual edges
  for (const conn of manual) {
    edges.push({
      id: `manual:${conn.id}`,
      source: `${conn.sourceType}:${conn.sourceId}`,
      sourceHandle: conn.sourceHandle ?? undefined,
      target: `${conn.targetType}:${conn.targetId}`,
      targetHandle: conn.targetHandle ?? undefined,
      type: 'manual',
      directed: conn.direction === 'forward',
      port: conn.port,
      protocol: conn.protocol,
      label: conn.label,
    });
  }

  return edges;
}

/**
 * Given collapsed server IDs and a set of topology edges,
 * aggregate edges that touch child nodes of collapsed servers — and,
 * optionally, collapsed clusters. When a cluster is collapsed, every server
 * inside it is bucketed as `cluster:<id>` regardless of the per-server
 * collapse state.
 *
 * `collapsedClusterIds` and `serverToCluster` are optional so existing callers
 * (and tests) keep working without clusters.
 */
export function aggregateCollapsedEdges(
  edges: TopologyEdge[],
  collapsedServerIds: Set<string>,
  serviceToServer: Map<string, string>, // serviceId -> serverId
  databaseToServer: Map<string, string>, // databaseId -> serverId
  collapsedClusterIds: Set<string> = new Set(),
  serverToCluster: Map<string, string> = new Map() // serverId -> clusterId
): TopologyEdge[] {
  if (collapsedServerIds.size === 0 && collapsedClusterIds.size === 0) return edges;

  const resolveNode = (nodeKey: string): string => {
    const [type, id] = nodeKey.split(':');
    // External entities and any unknown types pass through unchanged — they
    // never live inside a server group.
    if (type !== 'service' && type !== 'database') return nodeKey;

    const serverMap = type === 'service' ? serviceToServer : databaseToServer;
    const serverId = serverMap.get(id);

    if (serverId) {
      // Cluster takes precedence: a collapsed cluster swallows every child
      // server (even non-collapsed ones) into a single bucket.
      const clusterId = serverToCluster.get(serverId);
      if (clusterId && collapsedClusterIds.has(clusterId)) {
        return `cluster:${clusterId}`;
      }
      if (collapsedServerIds.has(serverId)) {
        return `server:${serverId}`;
      }
    }
    return nodeKey;
  };

  // Group edges by resolved source->target
  const grouped = new Map<string, { count: number; types: Set<string>; hasDirected: boolean; firstEdge: TopologyEdge }>();
  const result: TopologyEdge[] = [];

  for (const edge of edges) {
    const resolvedSource = resolveNode(edge.source);
    const resolvedTarget = resolveNode(edge.target);

    // If both resolve to the same collapsed server, skip (internal edge)
    if (resolvedSource === resolvedTarget) continue;

    // If neither changed, pass through as-is
    if (resolvedSource === edge.source && resolvedTarget === edge.target) {
      result.push(edge);
      continue;
    }

    const key = `${resolvedSource}->${resolvedTarget}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      existing.types.add(edge.type);
      if (edge.directed) existing.hasDirected = true;
    } else {
      grouped.set(key, { count: 1, types: new Set([edge.type]), hasDirected: edge.directed, firstEdge: edge });
    }
  }

  // Create aggregated edges
  for (const [key, info] of grouped) {
    const [source, target] = key.split('->');

    // When only one edge is aggregated, preserve the original edge data
    // (id keeps its `manual:<connId>` prefix so we don't lose the link to the
    // underlying connection), but flag it as aggregated so the inline X
    // delete button is hidden — the visible edge now reads as
    // server-to-X, and clicking X would delete an underlying connection the
    // user can no longer disambiguate.
    if (info.count === 1) {
      result.push({
        ...info.firstEdge,
        source,
        target,
        // Drop sourceHandle/targetHandle since they refer to the original
        // child node, not the rewritten endpoint.
        sourceHandle: undefined,
        targetHandle: undefined,
        aggregated: true,
      });
      continue;
    }

    const isMultiType = info.types.has('auto') && info.types.has('manual');
    result.push({
      id: `agg:${key}`,
      source,
      target,
      type: isMultiType ? 'auto' : (info.types.values().next().value as 'auto' | 'manual'),
      directed: info.hasDirected,
      label: `${info.count} connections`,
      aggregated: true,
    });
  }

  return result;
}
