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

  it('should set label to null for single aggregated edges', () => {
    const edges: TopologyEdge[] = [
      {
        id: 'auto:1',
        source: 'service:svc1',
        target: 'database:db1',
        type: 'auto',
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
    expect(result[0].label).toBeNull();
  });
});
