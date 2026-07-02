import { describe, it, expect } from 'vitest';
import {
  inferConnections,
  mergeConnections,
  aggregateCollapsedEdges,
  serviceInstanceId,
  serviceInstanceNodeId,
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

describe('serviceInstanceId / serviceInstanceNodeId', () => {
  it('should build "<serviceId>@<serverId>" and "service:<serviceId>@<serverId>"', () => {
    expect(serviceInstanceId('svc1', 's1')).toBe('svc1@s1');
    expect(serviceInstanceNodeId('svc1', 's1')).toBe('service:svc1@s1');
  });
});

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
      sourceServerId: 's1',
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
    expect(connections[0].sourceServerId).toBe('s1');
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

  it('should infer one edge per server when the same template is deployed on two servers', () => {
    // The same service template (svc1) is deployed on two servers, each
    // exposing the db container port under two host ports — exercising the
    // per-server dedupe: exactly one inferred edge per instance (not one
    // total, and not one per duplicate exposed-port entry).
    const exposedPorts =
      '[{"host":5432,"container":5432,"protocol":"tcp"},{"host":15432,"container":5432,"protocol":"tcp"}]';
    const server1 = createServer('s1', '10.0.0.1', [{ id: 'svc1', exposedPorts }]);
    const server2 = createServer('s2', '10.0.0.2', [{ id: 'svc1', exposedPorts }]);
    // host "localhost" matches services on any server
    const db = createDatabase('db1', { host: 'localhost', port: 5432 });

    const connections = inferConnections([server1, server2], [db]);
    expect(connections).toHaveLength(2);
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'svc1', sourceServerId: 's1', targetId: 'db1' }),
        expect.objectContaining({ sourceId: 'svc1', sourceServerId: 's2', targetId: 'db1' }),
      ])
    );
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
  // Shorthand for a manual service->service connection fixture.
  function createManualConnection(overrides: Partial<ServiceConnection> = {}): ServiceConnection {
    return {
      id: 'conn-1',
      sourceType: 'service',
      sourceId: 'svc1',
      targetType: 'service',
      targetId: 'svc2',
      port: 8080,
      protocol: 'http',
      direction: 'forward',
      label: 'API calls',
      ...overrides,
    } as ServiceConnection;
  }

  it('should return empty array for no connections', () => {
    expect(mergeConnections([], [])).toEqual([]);
  });

  it('should convert inferred connections to auto edges pinned to the source instance', () => {
    const inferred: InferredConnection[] = [
      {
        sourceType: 'service',
        sourceId: 'svc1',
        sourceServerId: 's1',
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
      id: 'auto:service:svc1@s1->database:db1:5432',
      type: 'auto',
      directed: true,
      source: 'service:svc1@s1',
      target: 'database:db1',
      port: 5432,
    });
  });

  it('should pin inferred edges from the same template to their own server instances', () => {
    // Two inferred connections for the same service template, one per server
    // — each must attach to its own instance node with a unique edge id.
    const base = {
      sourceType: 'service' as const,
      sourceId: 'svc1',
      targetType: 'database' as const,
      targetId: 'db1',
      port: 5432,
      protocol: 'tcp',
      label: 'PG',
    };
    const inferred: InferredConnection[] = [
      { ...base, sourceServerId: 's1' },
      { ...base, sourceServerId: 's2' },
    ];

    const edges = mergeConnections(inferred, []);
    expect(edges.map((e) => e.source)).toEqual(['service:svc1@s1', 'service:svc1@s2']);
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
  });

  it('should fall back to template node ids for manual edges when no instance map is provided', () => {
    const edges = mergeConnections([], [createManualConnection()]);
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
    const edges = mergeConnections([], [
      createManualConnection({ direction: 'bidirectional', label: null }),
    ]);
    expect(edges[0].directed).toBe(false);
  });

  it('should fan a template-scoped manual edge out to every instance of the source service', () => {
    const serviceInstances = new Map([
      ['svc1', ['service:svc1@s1', 'service:svc1@s2']],
      ['svc2', ['service:svc2@s1']],
    ]);

    const edges = mergeConnections([], [createManualConnection()], serviceInstances);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.source)).toEqual(['service:svc1@s1', 'service:svc1@s2']);
    for (const edge of edges) {
      expect(edge).toMatchObject({
        type: 'manual',
        target: 'service:svc2@s1',
        directed: true,
        port: 8080,
        label: 'API calls',
      });
    }
    // Fanned edges need unique React Flow ids, but each id must still map
    // back to the underlying connection (TopologyDiagram strips the suffix
    // after the first "@" to recover the connection id for deletion).
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.replace('manual:', '').split('@')[0]).toBe('conn-1');
    }
  });

  it('should fan out the cross product when both endpoints have multiple instances', () => {
    const serviceInstances = new Map([
      ['svc1', ['service:svc1@s1', 'service:svc1@s2']],
      ['svc2', ['service:svc2@s3', 'service:svc2@s4']],
    ]);

    const edges = mergeConnections([], [createManualConnection()], serviceInstances);
    expect(edges).toHaveLength(4);
    expect(new Set(edges.map((e) => e.id)).size).toBe(4);
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      'service:svc1@s1->service:svc2@s3',
      'service:svc1@s1->service:svc2@s4',
      'service:svc1@s2->service:svc2@s3',
      'service:svc1@s2->service:svc2@s4',
    ]);
  });

  it('should keep the plain manual edge id when neither endpoint fans out', () => {
    const serviceInstances = new Map([
      ['svc1', ['service:svc1@s1']],
      ['svc2', ['service:svc2@s2']],
    ]);

    const edges = mergeConnections([], [createManualConnection()], serviceInstances);
    expect(edges).toHaveLength(1);
    // Single-instance endpoints keep the deletable "manual:<connId>" id but
    // still attach to the instance nodes.
    expect(edges[0]).toMatchObject({
      id: 'manual:conn-1',
      source: 'service:svc1@s1',
      target: 'service:svc2@s2',
    });
  });

  it('should fall back to the template node id for a service missing from the instance map', () => {
    // svc2 has no known instances (e.g. no deployments yet) — the edge keeps
    // the plain template node id on that side so it stays parseable.
    const serviceInstances = new Map([['svc1', ['service:svc1@s1', 'service:svc1@s2']]]);

    const edges = mergeConnections([], [createManualConnection()], serviceInstances);
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.target).toBe('service:svc2');
    }
  });

  it('should not fan out database endpoints', () => {
    const conn = createManualConnection({
      targetType: 'database',
      targetId: 'db1',
    });
    const serviceInstances = new Map([['svc1', ['service:svc1@s1', 'service:svc1@s2']]]);

    const edges = mergeConnections([], [conn], serviceInstances);
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.target).toBe('database:db1');
    }
  });

  it('should combine both auto and manual edges', () => {
    const inferred: InferredConnection[] = [
      {
        sourceType: 'service',
        sourceId: 'svc1',
        sourceServerId: 's1',
        targetType: 'database',
        targetId: 'db1',
        port: 5432,
        protocol: 'tcp',
        label: 'PG',
      },
    ];

    const edges = mergeConnections(inferred, [createManualConnection({ label: null })]);
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
        source: 'service:svc1@server-1',
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
        source: 'service:svc1@server-1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
      {
        id: 'auto:2',
        source: 'service:svc2@server-1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];

    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc2@server-1', 'server-1'],
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
        source: 'service:svc1@server-1',
        target: 'service:svc2@server-1',
        type: 'manual',
        directed: true,
      },
    ];

    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc2@server-1', 'server-1'],
    ]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(0);
  });

  it('should collapse only the matching instance when a service is deployed on two servers', () => {
    // svc1 is deployed on server-1 (collapsed) and server-2 (expanded); each
    // instance has its own edge to db1. Only the server-1 instance's edge is
    // rewritten to the server bucket — the server-2 instance passes through.
    const edges: TopologyEdge[] = [
      {
        id: 'auto:service:svc1@server-1->database:db1:5432',
        source: 'service:svc1@server-1',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
      {
        id: 'auto:service:svc1@server-2->database:db1:5432',
        source: 'service:svc1@server-2',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];
    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc1@server-2', 'server-2'],
    ]);

    const result = aggregateCollapsedEdges(
      edges,
      new Set(['server-1']),
      serviceToServer,
      new Map()
    );

    expect(result).toHaveLength(2);
    const passThrough = result.find((e) => e.source === 'service:svc1@server-2');
    expect(passThrough).toEqual(edges[1]);
    const rewritten = result.find((e) => e.source === 'server:server-1');
    expect(rewritten).toBeDefined();
    expect(rewritten!.target).toBe('database:db1');
    expect(rewritten!.aggregated).toBe(true);
  });

  it('should pass through edges not touching collapsed servers', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'auto:1',
        source: 'service:svc1@server-2',
        target: 'database:db1',
        type: 'auto',
        directed: true,
      },
    ];

    // svc1's instance is on server-2, which is NOT collapsed
    const serviceToServer = new Map([['svc1@server-2', 'server-2']]);

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
        source: 'service:svc1@server-1',
        target: 'database:db1',
        type: 'manual',
        directed: true,
        label: 'API',
        port: 5432,
      },
    ];

    const serviceToServer = new Map([['svc1@server-1', 'server-1']]);

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
      { id: 'manual:1', source: 'service:svc1@server-1', target: 'database:db1', type: 'manual', directed: true },
      { id: 'manual:2', source: 'service:svc2@server-1', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc2@server-1', 'server-1'],
    ]);

    const result = aggregateCollapsedEdges(edges, new Set(['server-1']), serviceToServer, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].aggregated).toBe(true);
    expect(result[0].label).toBe('2 connections');
  });

  it('should NOT mark pass-through edges as aggregated', () => {
    const edges: TopologyEdge[] = [
      { id: 'auto:1', source: 'service:svc1@server-2', target: 'database:db1', type: 'auto', directed: true },
    ];
    const serviceToServer = new Map([['svc1@server-2', 'server-2']]);

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
        source: 'service:svc1@server-1',
        target: 'service:svc2@server-2',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc2@server-2', 'server-2'],
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
      { id: 'manual:1', source: 'service:svc1@server-1', target: 'service:svc3@server-3', type: 'manual', directed: true },
      { id: 'manual:2', source: 'service:svc2@server-2', target: 'service:svc4@server-4', type: 'manual', directed: true },
    ];
    // svc1, svc2 live in cluster-A; svc3, svc4 live in cluster-B.
    const serviceToServer = new Map([
      ['svc1@server-1', 'server-1'],
      ['svc2@server-2', 'server-2'],
      ['svc3@server-3', 'server-3'],
      ['svc4@server-4', 'server-4'],
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
      { id: 'manual:1', source: 'service:svc1@server-1', target: 'database:db1', type: 'manual', directed: true, label: 'PG' },
    ];
    const serviceToServer = new Map([['svc1@server-1', 'server-1']]);
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
      { id: 'manual:1', source: 'service:svc1@server-1', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([['svc1@server-1', 'server-1']]);
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
      { id: 'manual:1', source: 'service:svc-outside@server-2', target: 'database:db1', type: 'manual', directed: true },
    ];
    const serviceToServer = new Map([['svc-outside@server-2', 'server-2']]);
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
        source: 'service:svc1@server-2',
        sourceHandle: 'bottom',
        target: 'database:db1',
        targetHandle: 'top',
        type: 'manual',
        directed: true,
      },
    ];
    // svc1's instance is on server-2 which is NOT collapsed and not in any
    // cluster — edge passes through resolveNode untouched.
    const serviceToServer = new Map([['svc1@server-2', 'server-2']]);

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
        source: 'service:svc1@server-1',
        sourceHandle: 'bottom',
        target: 'database:db1',
        targetHandle: 'top',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([['svc1@server-1', 'server-1']]);

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
        target: 'service:svc1@server-2',
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
    // svc1's instance lives on server-2 which is NOT collapsed.
    const serviceToServer = new Map([['svc1@server-2', 'server-2']]);

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
        target: 'service:svc1@server-1',
        type: 'manual',
        directed: true,
      },
    ];
    const serviceToServer = new Map([['svc1@server-1', 'server-1']]);

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
