import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';
import * as api from '../lib/api';

// Mock Toast
vi.mock('../components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock API. listConfigFragments returns the list (with usedByCount); the detail
// endpoint getConfigFragment is lazily fetched per-id when "Used by" is expanded
// or the view modal is opened.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    listConfigFragments: vi.fn(),
    getConfigFragment: vi.fn(),
    createConfigFragment: vi.fn(),
    updateConfigFragment: vi.fn(),
    deleteConfigFragment: vi.fn(),
  };
});

const listConfigFragments = vi.mocked(api.listConfigFragments);
const getConfigFragment = vi.mocked(api.getConfigFragment);

const Fragments = (await import('./Fragments')).default;

const USED_FRAGMENT = {
  id: 'frag-used',
  name: 'common-env',
  description: 'Shared env block',
  content: 'KEY=value',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  usedByCount: 2,
};

const UNUSED_FRAGMENT = {
  id: 'frag-unused',
  name: 'orphan',
  description: null,
  content: 'NOTHING=here',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-10T00:00:00Z',
  usedByCount: 0,
};

const USAGE_DETAIL = {
  fragment: {
    ...USED_FRAGMENT,
    usedBy: [
      {
        configFileId: 'cf-1',
        configFileName: 'nginx.conf',
        configFileFilename: 'nginx.conf',
        position: 0,
        services: [
          { serviceId: 'svc-1', serviceName: 'api' },
          { serviceId: 'svc-2', serviceName: 'web' },
        ],
      },
    ],
  },
};

describe('Fragments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConfigFragments.mockResolvedValue({
      fragments: [USED_FRAGMENT, UNUSED_FRAGMENT],
      total: 2,
      limit: 200,
      offset: 0,
    });
    getConfigFragment.mockResolvedValue(USAGE_DETAIL);

    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
    });
  });

  async function renderAndWait() {
    renderWithProviders(<Fragments />);
    await waitFor(() => {
      expect(screen.getByText('common-env')).toBeInTheDocument();
    });
  }

  it('opens the read-only view modal from the eye action, and its Edit button transitions into the edit modal', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    // Eye action opens the read-only view modal (title "Fragment: <name>").
    await user.click(screen.getAllByTitle('View')[0]);
    const viewModal = await screen.findByRole('dialog', { name: 'Fragment: common-env' });
    // Read-only content is shown.
    expect(within(viewModal).getByText('KEY=value')).toBeInTheDocument();

    // The view modal's Edit button (text "Edit", not the row's title="Edit" icon)
    // transitions into the edit modal.
    await user.click(within(viewModal).getByRole('button', { name: 'Edit' }));
    const editModal = await screen.findByRole('dialog', { name: 'Edit fragment: common-env' });
    // View modal is gone; edit form is present (name pre-filled).
    expect(screen.queryByRole('dialog', { name: 'Fragment: common-env' })).not.toBeInTheDocument();
    expect(within(editModal).getByDisplayValue('common-env')).toBeInTheDocument();
  });

  it('expands the "Used by" cell with exactly one fetch and does not refetch on re-expand', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    // The count is rendered as a clickable expander button for usedByCount > 0.
    const expander = screen.getByRole('button', { name: /2/ });

    // Expand: fetches detail once and renders referencing config file + service links.
    await user.click(expander);
    const apiLink = await screen.findByRole('link', { name: 'api' });
    const webLink = screen.getByRole('link', { name: 'web' });
    // The referencing config file is linked.
    expect(screen.getByRole('link', { name: /nginx\.conf/ })).toHaveAttribute('href', '/config-files');
    expect(apiLink).toHaveAttribute('href', '/services/svc-1');
    expect(webLink).toHaveAttribute('href', '/services/svc-2');
    expect(getConfigFragment).toHaveBeenCalledTimes(1);
    expect(getConfigFragment).toHaveBeenCalledWith('frag-used');

    // Collapse, then re-expand: cached, so NO new fetch (guards "no N+1").
    await user.click(expander);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'api' })).not.toBeInTheDocument();
    });
    await user.click(expander);
    expect(await screen.findByRole('link', { name: 'api' })).toBeInTheDocument();
    expect(getConfigFragment).toHaveBeenCalledTimes(1);
  });

  it('renders "—" with no expander (and no fetch) for a fragment with usedByCount 0', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    // The unused fragment's row has no "Used by" button — only the row action buttons.
    const orphanRow = screen.getByText('orphan').closest('tr') as HTMLElement;
    const usedByCell = orphanRow.querySelectorAll('td')[2];
    expect(within(usedByCell).queryByRole('button')).not.toBeInTheDocument();
    expect(usedByCell).toHaveTextContent('—');

    // Clicking the dash text triggers no fetch.
    await user.click(usedByCell);
    expect(getConfigFragment).not.toHaveBeenCalled();
  });
});
