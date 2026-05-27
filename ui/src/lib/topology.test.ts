import { describe, it, expect } from 'vitest';
import {
  inferConnections,
  mergeConnections,
  aggregateCollapsedEdges,
  type InferredConnection,
  type TopologyEdge,
} from './topology';
import type { ServerWithServices, Database, ServiceConnection } from './api';

// Helper to create a minimal server with services
function createServer(
  id: string,
  hostname: string,
  services: Array<{
    id: string;
    exposedPorts: string | null;
  }>,
  publicIp?: string
): ServerWithServices {
  return {
    id,
    name: `server-${id}`,
    hostname,
    publicIp: publicIp ?? null,
    tags: '[]',
    status: 'healthy',
    serverType: 'remote',
    lastCheckedAt: null,
    environmentId: 'env-1',
    services: services.map((s) => ({
      id: s.id,
      name: `service-${s.id}`,
      containerName: `container-${s.id}`,
      imageTag: 'latest',
      composePath: null,
      healthCheckUrl: null,
      status: 'running',
      containerStatus: 'running',
      healthStatus: 'healthy',
      exposedPorts: s.exposedPorts,
      discoveryStatus: 'found',
      lastCheckedAt: null,
      lastDiscoveredAt: null,
      serverId: id,
      autoUpdate: false,
      latestAvailableTag: null,
      latestAvailableDigest: null,
      lastUpdateCheckAt: null,
    })) as ServerWithServices['services'],
  };
}

// Helper to create a minimal database
function createDatabase(
  id: string,
  opts: {
    serverId?: string;
    host?: string;
    port?: number;
    type?: string;
    databaseTypeName?: string;
  } = {}
): Database {
  return {
    id,
    name: `db-${id}`,
    type: opts.type ?? 'postgresql',
    host: opts.host ?? null,
    port: opts.port ?? 5432,
    serverId: opts.serverId ?? null,
    databaseType: opts.databaseTypeName
      ? { name: opts.databaseTypeName, displayName: opts.databaseTypeName }
      : undefined,
  } as Database;
}

describe('inferConnections', () => {
  it('should return empty array when no servers or databases', () => {
    expect(inferConnections([], [])).toEqual([]);
  });

  it('should match service to database on same server by port', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":5432,"container":5432,"protocol":"tcp"}]' },
    ]);
    const db = createDatabase('db1', { serverId: 's1', port: 5432 });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      sourceType: 'service',
      sourceId: 'svc1',
      targetType: 'database',
      targetId: 'db1',
      port: 5432,
      protocol: 'tcp',
    });
  });

  it('should match service to database on different server by host', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":5432,"container":5432,"protocol":"tcp"}]' },
    ]);
    const db = createDatabase('db1', { host: '10.0.0.1', port: 5432, serverId: 's2' });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(1);
    expect(connections[0].targetId).toBe('db1');
  });

  it('should match by well-known port when port matches database type', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":5432,"container":5432,"protocol":"tcp"}]' },
    ]);
    const db = createDatabase('db1', {
      serverId: 's2',
      host: '10.0.0.2',
      port: 9999,
      databaseTypeName: 'PostgreSQL',
    });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(1);
  });

  it('should deduplicate connections', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":5432,"container":5432,"protocol":"tcp"}]' },
    ]);
    // Same database matches via both same-server and host match
    const db = createDatabase('db1', { serverId: 's1', host: '10.0.0.1', port: 5432 });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(1);
  });

  it('should not match when ports do not match', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":8080,"container":8080,"protocol":"tcp"}]' },
    ]);
    const db = createDatabase('db1', { serverId: 's1', port: 5432 });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(0);
  });

  it('should handle null or invalid exposedPorts gracefully', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: null },
      { id: 'svc2', exposedPorts: 'not-json' },
    ]);
    const db = createDatabase('db1', { serverId: 's1', port: 5432 });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(0);
  });

  it('should skip databases without a port', () => {
    const server = createServer('s1', '10.0.0.1', [
      { id: 'svc1', exposedPorts: '[{"host":5432,"container":5432,"protocol":"tcp"}]' },
    ]);
    // Port is 0 (falsy) or null — should be skipped by `!db.port`
    const db = createDatabase('db1', { serverId: 's1', port: 0 });

    const connections = inferConnections([server], [db]);
    expect(connections).toHaveLength(0);
  });
});

describe('mergeConnections', () => {
  it('should return empty array for no connections', () => {
    expect(mergeConnections([], [])).toEqual([]);
  });

  it('should convert inferred connections to auto edges', () => {
    const inferred: InferredConnection[] = [
      {
        sourceType: 'service',
        sourceId: 'svc1',
        targetType: 'database',
        targetId: 'db1',
        port: 5432,
        protocol: 'tcp',
        label: 'PostgreSQL :5432',
      },
    ];

    const edges = mergeConnections(inferred, []);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      type: 'auto',
      directed: true,
      source: 'service:svc1',
      target: 'database:db1',
      port: 5432,
    });
  });

  it('should convert manual connections to manual edges', () => {
    const manual: ServiceConnection[] = [
      {
        id: 'conn-1',
        sourceType: 'service',
        sourceId: 'svc1',
        targetType: 'service',
        targetId: 'svc2',
        port: 8080,
        protocol: 'http',
        direction: 'forward',
        label: 'API calls',
      } as ServiceConnection,
    ];

    const edges = mergeConnections([], manual);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: 'manual:conn-1',
      type: 'manual',
      directed: true,
      source: 'service:svc1',
      target: 'service:svc2',
    });
  });

  it('should set directed=false for non-forward manual connections', () => {
    const manual = [
      {
        id: 'conn-1',
        sourceType: 'service',
        sourceId: 'svc1',
        targetType: 'service',
        targetId: 'svc2',
        port: 8080,
        protocol: 'http',
        direction: 'bidirectional',
        label: null,
      } as ServiceConnection,
    ];

    const edges = mergeConnections([], manual);
    expect(edges[0].directed).toBe(false);
  });

  it('should combine both auto and manual edges', () => {
    const inferred: InferredConnection[] = [
      {
        sourceType: 'service',
        sourceId: 'svc1',
        targetType: 'database',
        targetId: 'db1',
        port: 5432,
        protocol: 'tcp',
        label: 'PG',
      },
    ];
    const manual = [
      {
        id: 'conn-1',
        sourceType: 'service',
        sourceId: 'svc1',
        targetType: 'service',
        targetId: 'svc2',
        port: 80,
        protocol: 'http',
        direction: 'forward',
        label: null,
      } as ServiceConnection,
    ];

    const edges = mergeConnections(inferred, manual);
    expect(edges).toHaveLength(2);
    expect(edges.filter((e) => e.type === 'auto')).toHaveLength(1);
    expect(edges.filter((e) => e.type === 'manual')).toHaveLength(1);
  });
});

describe('aggregateCollapsedEdges', () => {
  it('should return edges unchanged when no servers are collapsed', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'auto:1',
        source: 'service:svc1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];

    const result = aggregateCollapsedEdges(
      edges,
      new Set(),
      new Map(),
      new Map()
    );
    expect(result).toEqual(edges);
  });

  it('should aggregate edges from collapsed server to external node', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'auto:1',
        source: 'service:svc1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
      {
        id: 'auto:2',
        source: 'service:svc2',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];

    const serviceToServer = new Map([
      ['svc1', 'server-1'],
      ['svc2', 'server-1'],
    ]);
    const databaseToServer = new Map<string, string>();

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      databaseToServer
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('server:server-1');
    expect(result[0].target).toBe('database:db1');
    expect(result[0].label).toBe('2 connections');
  });

  it('should skip internal edges within a collapsed server', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'service:svc1',
        target: 'service:svc2',
        type: 'manual',
        directed: true,
      },
    ];

    const serviceToServer = new Map([
      ['svc1', 'server-1'],
      ['svc2', 'server-1'],
    ]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(0);
  });

  it('should pass through edges not touching collapsed servers', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'auto:1',
        source: 'service:svc1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];

    // svc1 is on server-2, which is NOT collapsed
    const serviceToServer = new Map([['svc1', 'server-2']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edges[0]);
  });

  it('should preserve original edge data for single aggregated edges', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'manual:conn1',
        source: 'service:svc1',
        target: 'database:db1',
        type: 'manual',
        directed: true,
        label: 'API',
        port: 5432,
      },
    ];

    const serviceToServer = new Map([['svc1', 'server-1']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(1);
    // Single aggregated edges preserve original data (including manual: ID for delete)
    expect(result[0].id).toBe('manual:conn1');
    expect(result[0].type).toBe('manual');
    expect(result[0].label).toBe('API');
    expect(result[0].port).toBe(5432);
    expect(result[0].source).toBe('server:server-1');
    expect(result[0].target).toBe('database:db1');
    // But should be marked aggregated so the inline delete-X is suppressed —
    // the visible edge now reads as server→db, and a click would destroy a
    // connection the user can no longer disambiguate.
    expect(result[0].aggregated).toBe(true);
  });

  it('should mark count>1 aggregated edges as aggregated', () => {
    const edges: TopologyEdge[] = [
      { id: 'manual:1', source: 'service:svc1', target: 'database:db1', type: 'manual', directed: true },
      { id: 'manual:2', source: 'service:svc2', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([['svc1', 'server-1'], ['svc2', 'server-1']]);

    const result = aggregateCollapsedEdges(edges, new Set(['server-1']), serviceToServer, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].aggregated).toBe(true);
    expect(result[0].label).toBe('2 connections');
  });

  it('should NOT mark pass-through edges as aggregated', () => {
    const edges: TopologyEdge[] = [
      { id: 'auto:1', source: 'service:svc1', target: 'database:db1', type: 'auto', directed: true },
    ];
    const serviceToServer = new Map([['svc1', 'server-2']]);

    const result = aggregateCollapsedEdges(edges, new Set(['server-1']), serviceToServer, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].aggregated).toBeUndefined();
  });

  // -------------------- collapsed clusters --------------------

  it('should drop edges between two servers in the same collapsed cluster', () => {
    // svc1 (on server-1) -> svc2 (on server-2), both servers live in cluster-A.
    // When cluster-A is collapsed, both endpoints resolve to `cluster:cluster-A`
    // — same bucket, so the edge is internal and dropped (no self-loop emitted).
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'service:svc1',
        target: 'service:svc2',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([
      ['svc1', 'server-1'],
      ['svc2', 'server-2'],
    ]);
    const serverToCluster = new Map([
      ['server-1', 'cluster-A'],
      ['server-2', 'cluster-A'],
    ]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(),
      serviceToServer,
      new Map(),
      new Set(['cluster-A']),
      serverToCluster
    );

    expect(result).toHaveLength(0);
  });

  it('should aggregate edges between two different collapsed clusters into one cluster->cluster edge', () => {
    const edges: TopologyEdge[] = [
      { id: 'manual:1', source: 'service:svc1', target: 'service:svc3', type: 'manual', directed: true },
      { id: 'manual:2', source: 'service:svc2', target: 'service:svc4', type: 'manual', directed: true },
    ];
    // svc1, svc2 live in cluster-A; svc3, svc4 live in cluster-B.
    const serviceToServer = new Map([
      ['svc1', 'server-1'],
      ['svc2', 'server-2'],
      ['svc3', 'server-3'],
      ['svc4', 'server-4'],
    ]);
    const serverToCluster = new Map([
      ['server-1', 'cluster-A'],
      ['server-2', 'cluster-A'],
      ['server-3', 'cluster-B'],
      ['server-4', 'cluster-B'],
    ]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(),
      serviceToServer,
      new Map(),
      new Set(['cluster-A', 'cluster-B']),
      serverToCluster
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('cluster:cluster-A');
    expect(result[0].target).toBe('cluster:cluster-B');
    expect(result[0].label).toBe('2 connections');
    expect(result[0].aggregated).toBe(true);
  });

  it('should aggregate edges from a clustered server to a non-clustered node as cluster->node', () => {
    const edges: TopologyEdge[] = [
      // svc1 inside cluster-A, db1 not in any cluster.
      { id: 'manual:1', source: 'service:svc1', target: 'database:db1', type: 'manual', directed: true, label: 'PG' },
    ];
    const serviceToServer = new Map([['svc1', 'server-1']]);
    const databaseToServer = new Map<string, string>(); // db1 unmapped -> passes through
    const serverToCluster = new Map([['server-1', 'cluster-A']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(),
      serviceToServer,
      databaseToServer,
      new Set(['cluster-A']),
      serverToCluster
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('cluster:cluster-A');
    expect(result[0].target).toBe('database:db1');
    // Single-edge aggregation preserves the original ID and metadata, but
    // flags aggregated=true (so the inline delete-X stays hidden).
    expect(result[0].id).toBe('manual:1');
    expect(result[0].label).toBe('PG');
    expect(result[0].aggregated).toBe(true);
  });

  it('should let cluster win when a server is collapsed AND its cluster is collapsed', () => {
    // svc1 lives on server-1, which is BOTH collapsed and inside collapsed cluster-A.
    // The cluster bucket takes precedence — endpoint resolves to `cluster:cluster-A`,
    // not `server:server-1`.
    const edges: TopologyEdge[] = [
      { id: 'manual:1', source: 'service:svc1', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([['svc1', 'server-1']]);
    const serverToCluster = new Map([['server-1', 'cluster-A']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map(),
      new Set(['cluster-A']),
      serverToCluster
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('cluster:cluster-A');
    expect(result[0].target).toBe('database:db1');
  });

  it('should treat collapsed cluster as transparent for servers that are not its members', () => {
    // server-1 is in cluster-A (collapsed). server-2 is NOT in any cluster
    // and is also not in collapsedServerIds. svc on server-2 must pass through
    // unchanged.
    const edges: TopologyEdge[] = [
      { id: 'manual:1', source: 'service:svc-outside', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([['svc-outside', 'server-2']]);
    const serverToCluster = new Map([['server-1', 'cluster-A']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(),
      serviceToServer,
      new Map(),
      new Set(['cluster-A']),
      serverToCluster
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edges[0]);
  });

  // -------------------- handle preservation --------------------

  it('should preserve sourceHandle/targetHandle on pass-through (non-aggregated) edges', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'service:svc1',
        sourceHandle: 'bottom',
        target: 'database:db1',
        targetHandle: 'top',
        type: 'manual',
        directed: true,
      },
    ];
    // svc1 is on server-2 which is NOT collapsed and not in any cluster
    // — edge passes through resolveNode untouched.
    const serviceToServer = new Map([['svc1', 'server-2']]);

    const result = aggregateCollapsedEdges(edges, new Set(['server-1']), serviceToServer, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].sourceHandle).toBe('bottom');
    expect(result[0].targetHandle).toBe('top');
  });

  it('should drop sourceHandle/targetHandle on aggregated single edges', () => {
    // When the endpoint is rewritten (cluster wins), the original handle id
    // pointed at the child node — it's no longer meaningful on the rewritten
    // endpoint, so the aggregation step zeroes it out.
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'service:svc1',
        sourceHandle: 'bottom',
        target: 'database:db1',
        targetHandle: 'top',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([['svc1', 'server-1']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('server:server-1');
    expect(result[0].aggregated).toBe(true);
    expect(result[0].sourceHandle).toBeUndefined();
    expect(result[0].targetHandle).toBeUndefined();
  });

  // -------------------- unknown / external prefixes --------------------

  it('should pass external/unknown-prefix endpoints through unchanged', () => {
    // `external:` (and any non-service/non-database prefix) is treated as
    // pass-through by resolveNode — these nodes never live inside a server
    // group, so collapsing servers/clusters must not rewrite them.
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'external:ext1',
        sourceHandle: 'right',
        target: 'service:svc1',
        targetHandle: 'left',
        type: 'manual',
        directed: true,
      },
      {
        id: 'manual:2',
        source: 'something-weird:foo',
        target: 'external:ext2',
        type: 'manual',
        directed: false,
      },
    ];
    // svc1 lives on server-2 which is NOT collapsed.
    const serviceToServer = new Map([['svc1', 'server-2']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(2);
    // Both edges pass through unchanged — including handles.
    expect(result[0]).toEqual(edges[0]);
    expect(result[1]).toEqual(edges[1]);
  });

  it('should rewrite the service side of an external->service edge when the server is collapsed', () => {
    // The external endpoint stays put; only the service endpoint moves to its
    // server bucket. The edge becomes external:ext1 -> server:server-1.
    const edges: TopologyEdge[] = [
      {
        id: 'manual:1',
        source: 'external:ext1',
        target: 'service:svc1',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([['svc1', 'server-1']]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('external:ext1');
    expect(result[0].target).toBe('server:server-1');
    expect(result[0].aggregated).toBe(true);
  });
});
