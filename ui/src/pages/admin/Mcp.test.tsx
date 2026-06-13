import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { useAuthStore } from '../../lib/store';
import type { McpStatus } from '../../lib/api';

vi.mock('../../components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const baseTools: McpStatus['tools'] = [
  {
    name: 'list_servers',
    title: 'List servers',
    description: 'List servers in an environment.',
    requiredScope: null,
    destructive: false,
    readOnly: true,
    envScoped: true,
  },
  {
    name: 'deploy_service',
    title: 'Deploy service',
    description: 'Deploy a service template.',
    requiredScope: 'services:write',
    destructive: true,
    readOnly: false,
    envScoped: false,
  },
];

const baseResources: McpStatus['resources'] = [
  {
    name: 'config-files',
    title: 'Config files',
    description: 'Browse and read config files.',
    requiredScope: null,
    envScoped: false,
    uriTemplate: 'bridgeport:///config-files/{id}',
  },
];

const mockStatus = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    getMcpStatus: () => mockStatus(),
  };
});

const Mcp = (await import('./Mcp')).default;

function buildStatus(overrides: Partial<McpStatus> = {}): McpStatus {
  return {
    enabled: true,
    endpointPath: '/mcp',
    dnsRebindingProtection: { configured: false, allowedHosts: [] },
    tools: baseTools,
    resources: baseResources,
    counts: { tools: 2, readTools: 1, writeTools: 1, resources: 1 },
    ...overrides,
  };
}

describe('Mcp admin page', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
    mockStatus.mockReset();
  });

  it('shows an Enabled badge and the endpoint + tool inventory when enabled', async () => {
    mockStatus.mockResolvedValue(buildStatus());
    renderWithProviders(<Mcp />);

    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
    // Endpoint URL derived from origin + path.
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    // Tools rendered.
    expect(screen.getByText('list_servers')).toBeInTheDocument();
    expect(screen.getByText('deploy_service')).toBeInTheDocument();
    // Resources rendered.
    expect(screen.getByText('config-files')).toBeInTheDocument();
    expect(screen.getByText('bridgeport:///config-files/{id}')).toBeInTheDocument();
  });

  it('shows the disabled callout and how-to-enable when MCP is disabled', async () => {
    mockStatus.mockResolvedValue(buildStatus({ enabled: false }));
    renderWithProviders(<Mcp />);

    await waitFor(() => {
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
    expect(screen.getByText(/MCP server is disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/MCP_ENABLED=true/)).toBeInTheDocument();
    // Inventory still shown even when disabled.
    expect(screen.getByText('list_servers')).toBeInTheDocument();
  });
});
