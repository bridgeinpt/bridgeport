import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/render';
import { ConfirmProvider } from '@/hooks/useConfirm';
import type { ServerWithServices, Database } from '../../lib/api';

// Stub the ReactFlow canvas itself: jsdom can't lay out the flow, and the
// handlers under test (onConnect, onEdgesChange) plus the computed edges are
// plain props we can read/invoke from the captured call. Everything else
// (ReactFlowProvider, hooks, types) stays real.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: vi.fn(() => <div data-testid="react-flow" />),
  };
});

// Stable toast spies (module also exports `toast` for AddConnectionModal).
const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
};
vi.mock('../Toast', () => ({
  useToast: () => mockToast,
  toast: mockToast,
}));

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    listConnections: vi.fn().mockResolvedValue({ connections: [] }),
    createConnection: vi.fn(),
    deleteConnection: vi.fn().mockResolvedValue({ success: true }),
    getDiagramLayout: vi.fn().mockResolvedValue({ layout: null }),
    listExternalEntities: vi.fn().mockResolvedValue({ externalEntities: [] }),
    listServerClusters: vi.fn().mockResolvedValue({ serverClusters: [] }),
  };
});

const { TopologyDiagram } = await import('./TopologyDiagram');

// Latest props handed to the stubbed ReactFlow in the current test.
async function lastFlowProps() {
  const { ReactFlow } = await import('@xyflow/react');
  const calls = vi.mocked(ReactFlow).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as unknown as {
    edges: Array<{ id: string }>;
    onConnect: (conn: {
      source: string;
      sourceHandle: string | null;
      target: string;
      targetHandle: string | null;
    }) => Promise<void>;
    onEdgesChange: (changes: Array<{ type: 'remove'; id: string }>) => void;
  };
}

// Server row with (already fanned-out) service instance rows — the shape the
// Dashboard's serversWithServices memo feeds in. exposedPorts stays null so
// no auto edges are inferred.
function makeServer(id: string, name: string, serviceIds: string[]): ServerWithServices {
  return {
    id,
    name,
    hostname: `10.0.0.${id.slice(-1)}`,
    publicIp: null,
    tags: '[]',
    status: 'healthy',
    serverType: 'remote',
    lastCheckedAt: null,
    environmentId: 'env-1',
    services: serviceIds.map((sid) => ({
      id: sid,
      name: `service-${sid}`,
      containerName: `container-${sid}`,
      imageTag: 'latest',
      composePath: null,
      healthCheckUrl: null,
      status: 'running',
      containerStatus: 'running',
      healthStatus: 'healthy',
      exposedPorts: null,
      discoveryStatus: 'found',
      lastCheckedAt: null,
      lastDiscoveredAt: null,
      serverId: id,
      autoUpdate: false,
      latestAvailableTag: null,
      latestAvailableDigest: null,
      lastUpdateCheckAt: null,
    })) as ServerWithServices['services'],
  } as ServerWithServices;
}

const standaloneDb = {
  id: 'db-1',
  name: 'primary-db',
  type: 'postgresql',
  host: null,
  port: 5432,
  serverId: null,
} as unknown as Database;

// svc-1 is deployed on BOTH servers (one instance node each); svc-2 only on s1.
const twoServerFixture: ServerWithServices[] = [
  makeServer('s1', 'web-01', ['svc-1', 'svc-2']),
  makeServer('s2', 'web-02', ['svc-1']),
];

function renderDiagram(servers: ServerWithServices[] = twoServerFixture) {
  return renderWithProviders(
    <ConfirmProvider>
      <TopologyDiagram
        servers={servers}
        databases={[standaloneDb]}
        environmentId="env-1"
        userRole="admin"
      />
    </ConfirmProvider>
  );
}

// Template-scoped manual connection from multi-instance svc-1 to the db —
// mergeConnections fans it out to one edge per svc-1 instance.
const fannedConnection = {
  id: 'conn-1',
  environmentId: 'env-1',
  sourceType: 'service',
  sourceId: 'svc-1',
  targetType: 'database',
  targetId: 'db-1',
  port: null,
  protocol: null,
  label: 'reads/writes',
  direction: 'forward',
};

// svc-2 has a single instance, so this renders as exactly one edge.
const singleInstanceConnection = {
  ...fannedConnection,
  id: 'conn-2',
  sourceId: 'svc-2',
};

describe('TopologyDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== unique service count (F6) ====================

  it('counts unique service templates in the header, not fanned deployment rows', async () => {
    renderDiagram();
    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    // svc-1 appears under both servers (2 rows) + svc-2 under one -> 2 unique
    // templates, not 3 deployment rows.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          el.textContent?.replace(/\s+/g, ' ').trim() === '2 servers · 2 services · 1 database'
      )
    ).toBeInTheDocument();
  });

  // ==================== same-service connect guard (F4) ====================

  it('rejects connecting two instances of the same service with an explanatory toast', async () => {
    const api = await import('../../lib/api');
    renderDiagram();
    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    const props = await lastFlowProps();
    await act(async () => {
      await props.onConnect({
        source: 'service:svc-1@s1',
        sourceHandle: null,
        target: 'service:svc-1@s2',
        targetHandle: null,
      });
    });

    expect(mockToast.info).toHaveBeenCalledWith(
      'These are two instances of the same service — connections are service-scoped.'
    );
    expect(vi.mocked(api.createConnection)).not.toHaveBeenCalled();
  });

  it('creates a template-scoped connection when dragging between different nodes', async () => {
    const api = await import('../../lib/api');
    vi.mocked(api.createConnection).mockResolvedValueOnce(
      fannedConnection as Awaited<ReturnType<typeof api.createConnection>>
    );
    renderDiagram();
    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    const props = await lastFlowProps();
    await act(async () => {
      await props.onConnect({
        source: 'service:svc-1@s1',
        sourceHandle: 'right',
        target: 'database:db-1',
        targetHandle: 'left',
      });
    });

    // The instance suffix ("@s1") is stripped: connections are stored against
    // the service template.
    expect(vi.mocked(api.createConnection)).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'service',
        sourceId: 'svc-1',
        targetType: 'database',
        targetId: 'db-1',
      })
    );
    expect(mockToast.info).not.toHaveBeenCalled();
  });

  // ==================== multi-instance delete confirmation (F5) ====================

  async function removeEdge(edgeId: string) {
    // Wait until the fanned manual edges have been merged into flowEdges,
    // then fire a ReactFlow "remove" change (what Backspace/Delete and the
    // inline X funnel into) for the given edge.
    await waitFor(async () => {
      const props = await lastFlowProps();
      expect(props.edges.some((e) => e.id === edgeId)).toBe(true);
    });
    const props = await lastFlowProps();
    await act(async () => {
      props.onEdgesChange([{ type: 'remove', id: edgeId }]);
    });
  }

  it('asks for confirmation before deleting a connection that renders on several instances', async () => {
    const api = await import('../../lib/api');
    vi.mocked(api.listConnections).mockResolvedValue({
      connections: [fannedConnection],
    } as Awaited<ReturnType<typeof api.listConnections>>);

    renderDiagram();
    await removeEdge('manual:conn-1@service:svc-1@s1->database:db-1');

    // Blast radius named: svc-1 has 2 instances -> 2 edges vanish.
    expect(
      await screen.findByText(/appears on 2 server instances; deleting removes all of them/)
    ).toBeInTheDocument();
    expect(vi.mocked(api.deleteConnection)).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(vi.mocked(api.deleteConnection)).toHaveBeenCalledWith('conn-1');
    });
  });

  it('does not delete a multi-instance connection when the confirmation is cancelled', async () => {
    const api = await import('../../lib/api');
    vi.mocked(api.listConnections).mockResolvedValue({
      connections: [fannedConnection],
    } as Awaited<ReturnType<typeof api.listConnections>>);

    renderDiagram();
    await removeEdge('manual:conn-1@service:svc-1@s1->database:db-1');

    await screen.findByText(/appears on 2 server instances/);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(vi.mocked(api.deleteConnection)).not.toHaveBeenCalled();
  });

  it('deletes a single-instance connection immediately without a confirmation', async () => {
    const api = await import('../../lib/api');
    vi.mocked(api.listConnections).mockResolvedValue({
      connections: [singleInstanceConnection],
    } as Awaited<ReturnType<typeof api.listConnections>>);

    renderDiagram();
    await removeEdge('manual:conn-2@service:svc-2@s1->database:db-1');

    await waitFor(() => {
      expect(vi.mocked(api.deleteConnection)).toHaveBeenCalledWith('conn-2');
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
