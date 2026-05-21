import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    registryConnection: {
      findUnique: vi.fn(),
    },
    serverRegistryLogin: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({ prisma: mockPrisma }));

vi.mock('./registries.js', async () => {
  const actual = await vi.importActual<typeof import('./registries.js')>('./registries.js');
  return {
    ...actual,
    getRegistryCredentials: vi.fn(),
  };
});

import {
  toDockerLoginArgs,
  normalizeRegistryHost,
  ensureRegistryLogin,
  invalidateRegistryLogins,
  getSocketAuthConfig,
} from './registry-login.js';
import { getRegistryCredentials } from './registries.js';

const mockGetCreds = vi.mocked(getRegistryCredentials);

describe('normalizeRegistryHost', () => {
  it('strips https scheme', () => {
    expect(normalizeRegistryHost('https://registry.example.com')).toBe('registry.example.com');
  });

  it('strips http scheme', () => {
    expect(normalizeRegistryHost('http://10.0.0.5:5000')).toBe('10.0.0.5:5000');
  });

  it('strips trailing slash', () => {
    expect(normalizeRegistryHost('https://registry.example.com/')).toBe('registry.example.com');
  });

  it('strips trailing /v2 (V2 API suffix)', () => {
    expect(normalizeRegistryHost('https://registry.example.com/v2')).toBe('registry.example.com');
  });

  it('leaves bare hostnames untouched', () => {
    expect(normalizeRegistryHost('registry.digitalocean.com')).toBe('registry.digitalocean.com');
  });
});

describe('toDockerLoginArgs', () => {
  it('digitalocean: uses the token as both username and password', () => {
    const args = toDockerLoginArgs({
      type: 'digitalocean',
      registryUrl: 'https://api.digitalocean.com/v2/registry',
      repositoryPrefix: 'my-registry',
      token: 'dop_v1_abc',
    });

    expect(args).toEqual({
      registryHost: 'registry.digitalocean.com',
      username: 'dop_v1_abc',
      password: 'dop_v1_abc',
    });
  });

  it('digitalocean: returns null without a token', () => {
    expect(
      toDockerLoginArgs({
        type: 'digitalocean',
        registryUrl: 'https://api.digitalocean.com/v2/registry',
        repositoryPrefix: 'my-registry',
      })
    ).toBeNull();
  });

  it('dockerhub: uses empty host (docker login default) and prefers token over password', () => {
    const args = toDockerLoginArgs({
      type: 'dockerhub',
      registryUrl: 'https://hub.docker.com',
      repositoryPrefix: null,
      username: 'alice',
      token: 'dckr_pat_xyz',
      password: 'fallback',
    });

    expect(args).toEqual({
      registryHost: '',
      username: 'alice',
      password: 'dckr_pat_xyz',
    });
  });

  it('dockerhub: falls back to password when no token', () => {
    const args = toDockerLoginArgs({
      type: 'dockerhub',
      registryUrl: 'https://hub.docker.com',
      repositoryPrefix: null,
      username: 'alice',
      password: 'hunter2',
    });

    expect(args?.password).toBe('hunter2');
  });

  it('dockerhub: returns null without username', () => {
    expect(
      toDockerLoginArgs({
        type: 'dockerhub',
        registryUrl: 'https://hub.docker.com',
        repositoryPrefix: null,
        password: 'hunter2',
      })
    ).toBeNull();
  });

  it('generic: normalizes the host', () => {
    const args = toDockerLoginArgs({
      type: 'generic',
      registryUrl: 'https://registry.example.com/v2',
      repositoryPrefix: null,
      username: 'alice',
      password: 'hunter2',
    });

    expect(args).toEqual({
      registryHost: 'registry.example.com',
      username: 'alice',
      password: 'hunter2',
    });
  });

  it('generic: returns null when username or password is missing', () => {
    expect(
      toDockerLoginArgs({
        type: 'generic',
        registryUrl: 'https://registry.example.com',
        repositoryPrefix: null,
        username: 'alice',
      })
    ).toBeNull();
  });

  it('returns null for unsupported types', () => {
    expect(
      toDockerLoginArgs({
        type: 'gcr',
        registryUrl: 'https://gcr.io',
        repositoryPrefix: null,
        token: 'tok',
      })
    ).toBeNull();
  });
});

describe('ensureRegistryLogin', () => {
  const now = new Date('2026-05-21T12:00:00Z');
  const earlier = new Date('2026-05-21T10:00:00Z');
  const later = new Date('2026-05-21T14:00:00Z');

  function makeDocker() {
    return { login: vi.fn().mockResolvedValue(undefined) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns registry-not-found when the connection does not exist', async () => {
    mockPrisma.registryConnection.findUnique.mockResolvedValue(null);

    const docker = makeDocker();
    const result = await ensureRegistryLogin('srv-1', 'reg-1', docker as never);

    expect(result).toEqual({ loggedIn: false, reason: 'registry-not-found' });
    expect(docker.login).not.toHaveBeenCalled();
  });

  it('returns no-credentials when the registry has no usable auth', async () => {
    mockPrisma.registryConnection.findUnique.mockResolvedValue({ id: 'reg-1', updatedAt: now });
    mockGetCreds.mockResolvedValue({
      type: 'generic',
      registryUrl: 'https://registry.example.com',
      repositoryPrefix: null,
      // no username/password
    });

    const docker = makeDocker();
    const result = await ensureRegistryLogin('srv-1', 'reg-1', docker as never);

    expect(result).toEqual({ loggedIn: false, reason: 'no-credentials' });
    expect(docker.login).not.toHaveBeenCalled();
  });

  it('skips login when an existing row is at least as fresh as the registry updatedAt', async () => {
    mockPrisma.registryConnection.findUnique.mockResolvedValue({ id: 'reg-1', updatedAt: earlier });
    mockGetCreds.mockResolvedValue({
      type: 'generic',
      registryUrl: 'https://registry.example.com',
      repositoryPrefix: null,
      username: 'alice',
      password: 'hunter2',
    });
    mockPrisma.serverRegistryLogin.findUnique.mockResolvedValue({ loggedInAt: now });

    const docker = makeDocker();
    const result = await ensureRegistryLogin('srv-1', 'reg-1', docker as never);

    expect(result).toEqual({ loggedIn: false, reason: 'fresh' });
    expect(docker.login).not.toHaveBeenCalled();
    expect(mockPrisma.serverRegistryLogin.upsert).not.toHaveBeenCalled();
  });

  it('runs docker login and upserts the row when no prior login exists', async () => {
    mockPrisma.registryConnection.findUnique.mockResolvedValue({ id: 'reg-1', updatedAt: now });
    mockGetCreds.mockResolvedValue({
      type: 'generic',
      registryUrl: 'https://registry.example.com',
      repositoryPrefix: null,
      username: 'alice',
      password: 'hunter2',
    });
    mockPrisma.serverRegistryLogin.findUnique.mockResolvedValue(null);

    const docker = makeDocker();
    const result = await ensureRegistryLogin('srv-1', 'reg-1', docker as never);

    expect(docker.login).toHaveBeenCalledWith('registry.example.com', 'alice', 'hunter2');
    expect(mockPrisma.serverRegistryLogin.upsert).toHaveBeenCalledWith({
      where: { serverId_registryConnectionId: { serverId: 'srv-1', registryConnectionId: 'reg-1' } },
      create: expect.objectContaining({ serverId: 'srv-1', registryConnectionId: 'reg-1' }),
      update: expect.objectContaining({}),
    });
    expect(result).toEqual({ loggedIn: true, reason: 'logged-in', registryHost: 'registry.example.com' });
  });

  it('runs docker login when the existing row is stale (registry updated after login)', async () => {
    mockPrisma.registryConnection.findUnique.mockResolvedValue({ id: 'reg-1', updatedAt: later });
    mockGetCreds.mockResolvedValue({
      type: 'generic',
      registryUrl: 'https://registry.example.com',
      repositoryPrefix: null,
      username: 'alice',
      password: 'hunter2',
    });
    mockPrisma.serverRegistryLogin.findUnique.mockResolvedValue({ loggedInAt: earlier });

    const docker = makeDocker();
    await ensureRegistryLogin('srv-1', 'reg-1', docker as never);

    expect(docker.login).toHaveBeenCalledTimes(1);
    expect(mockPrisma.serverRegistryLogin.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateRegistryLogins', () => {
  it('deletes all rows for the given registry', async () => {
    mockPrisma.serverRegistryLogin.deleteMany.mockResolvedValue({ count: 3 });

    await invalidateRegistryLogins('reg-1');

    expect(mockPrisma.serverRegistryLogin.deleteMany).toHaveBeenCalledWith({
      where: { registryConnectionId: 'reg-1' },
    });
  });
});

describe('getSocketAuthConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when there are no credentials', async () => {
    mockGetCreds.mockResolvedValue(null);
    expect(await getSocketAuthConfig('reg-1')).toBeNull();
  });

  it('returns null when credentials cannot produce a login', async () => {
    mockGetCreds.mockResolvedValue({
      type: 'generic',
      registryUrl: 'https://registry.example.com',
      repositoryPrefix: null,
    });
    expect(await getSocketAuthConfig('reg-1')).toBeNull();
  });

  it('shapes credentials as a dockerode authconfig', async () => {
    mockGetCreds.mockResolvedValue({
      type: 'digitalocean',
      registryUrl: 'https://api.digitalocean.com/v2/registry',
      repositoryPrefix: 'my-registry',
      token: 'dop_v1_abc',
    });

    expect(await getSocketAuthConfig('reg-1')).toEqual({
      username: 'dop_v1_abc',
      password: 'dop_v1_abc',
      serveraddress: 'registry.digitalocean.com',
    });
  });
});
