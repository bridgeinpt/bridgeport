import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/render';
import { AddConnectionModal } from './AddConnectionModal';
import type { ServerWithServices, Database } from '../../lib/api';

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
      exposedPorts: null,
      status: 'running',
      containerStatus: 'running',
      healthStatus: 'healthy',
      discoveryStatus: 'found',
      serverId: id,
    })) as unknown as ServerWithServices['services'],
  } as ServerWithServices;
}

describe('AddConnectionModal', () => {
  it('offers a multi-deployment service once, with a group label listing all its servers', async () => {
    // svc-1 is deployed on both servers — it must appear as ONE option
    // (duplicate ids would collide as React keys / Radix Select values);
    // svc-2 keeps its single-server group label.
    const servers = [
      makeServer('s1', 'web-01', ['svc-1', 'svc-2']),
      makeServer('s2', 'web-02', ['svc-1']),
    ];

    renderWithProviders(
      <AddConnectionModal
        isOpen
        onClose={vi.fn()}
        environmentId="env-1"
        servers={servers}
        databases={[] as Database[]}
        onConnectionCreated={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'Source' }));

    const multiDeploy = screen.getAllByRole('option', { name: /service-svc-1/ });
    expect(multiDeploy).toHaveLength(1);
    expect(multiDeploy[0]).toHaveTextContent(
      '[Service] service-svc-1 (Servers: web-01, web-02)'
    );

    const singleDeploy = screen.getAllByRole('option', { name: /service-svc-2/ });
    expect(singleDeploy).toHaveLength(1);
    expect(singleDeploy[0]).toHaveTextContent('[Service] service-svc-2 (Server: web-01)');
  });
});
