import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RegistryFactory,
  DORegistryClient,
  DockerHubClient,
  GenericRegistryClient,
} from './registry.js';
import type { RegistryCredentials } from './registry.js';

// Mock system settings for GenericRegistryClient
vi.mock('../services/system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    registryMaxTags: 100,
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('registry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('RegistryFactory', () => {
    it('should create a DORegistryClient for digitalocean type', () => {
      const creds: RegistryCredentials = {
        type: 'digitalocean',
        registryUrl: 'registry.digitalocean.com',
        repositoryPrefix: 'my-registry',
        token: 'do-token',
      };

      const client = RegistryFactory.create(creds);
      expect(client).toBeInstanceOf(DORegistryClient);
    });

    it('should throw when digitalocean type has no token', () => {
      const creds: RegistryCredentials = {
        type: 'digitalocean',
        registryUrl: 'registry.digitalocean.com',
        repositoryPrefix: null,
      };

      expect(() => RegistryFactory.create(creds)).toThrow('Token required for DigitalOcean registry');
    });

    it('should create a DockerHubClient for dockerhub type', () => {
      const creds: RegistryCredentials = {
        type: 'dockerhub',
        registryUrl: 'docker.io',
        repositoryPrefix: null,
        token: 'hub-token',
      };

      const client = RegistryFactory.create(creds);
      expect(client).toBeInstanceOf(DockerHubClient);
    });

    it('should create a GenericRegistryClient for generic type', () => {
      const creds: RegistryCredentials = {
        type: 'generic',
        registryUrl: 'https://my.registry.com',
        repositoryPrefix: null,
        username: 'user',
        password: 'pass',
      };

      const client = RegistryFactory.create(creds);
      expect(client).toBeInstanceOf(GenericRegistryClient);
    });

    it('should throw for unsupported registry type', () => {
      const creds: RegistryCredentials = {
        type: 'unknown',
        registryUrl: 'foo.com',
        repositoryPrefix: null,
      };

      expect(() => RegistryFactory.create(creds)).toThrow('Unsupported registry type: unknown');
    });

    it('should use repositoryPrefix as registryName for DO client', () => {
      const creds: RegistryCredentials = {
        type: 'digitalocean',
        registryUrl: 'registry.digitalocean.com',
        repositoryPrefix: 'custom-registry',
        token: 'do-token',
      };

      const client = RegistryFactory.create(creds);
      expect(client).toBeInstanceOf(DORegistryClient);
    });
  });

  describe('DORegistryClient', () => {
    let client: DORegistryClient;

    beforeEach(() => {
      client = new DORegistryClient('test-token', 'test-registry');
    });

    describe('testConnection', () => {
      it('should call the DO registry API root', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ registry: { name: 'test-registry' } }),
        });

        await expect(client.testConnection()).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.digitalocean.com/v2/registry',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-token',
            }),
          }),
        );
      });

      it('should throw on API error', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        });

        await expect(client.testConnection()).rejects.toThrow('Registry API error: 401');
      });
    });

    describe('listRepositories', () => {
      it('should return mapped repository list', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            repositories: [
              { name: 'app-api', tagCount: 5, registryName: 'test-registry', latestTag: {} },
              { name: 'app-web', tagCount: 3, registryName: 'test-registry', latestTag: {} },
            ],
          }),
        });

        const repos = await client.listRepositories();
        expect(repos).toEqual([
          { name: 'app-api', tagCount: 5 },
          { name: 'app-web', tagCount: 3 },
        ]);
      });
    });

    describe('listTags', () => {
      it('should return mapped tag list', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            tags: [
              {
                tag: 'v1.0',
                manifestDigest: 'sha256:abc',
                sizeBytes: 1024,
                updatedAt: '2025-01-01T00:00:00Z',
                registryName: 'test',
                repository: 'app',
                compressedSizeBytes: 512,
              },
            ],
          }),
        });

        const tags = await client.listTags('app');
        expect(tags).toEqual([
          { tag: 'v1.0', digest: 'sha256:abc', size: 1024, updatedAt: '2025-01-01T00:00:00Z' },
        ]);
      });

      it('should paginate when there are more tags than perPage', async () => {
        // First page: full page (100 tags)
        const page1Tags = Array.from({ length: 100 }, (_, i) => ({
          tag: `v${i}`,
          manifestDigest: `sha${i}`,
          sizeBytes: 100,
          updatedAt: '2025-01-01T00:00:00Z',
          registryName: 'test',
          repository: 'app',
          compressedSizeBytes: 50,
        }));

        // Second page: partial page (fewer than 100)
        const page2Tags = [
          {
            tag: 'v100',
            manifestDigest: 'sha100',
            sizeBytes: 100,
            updatedAt: '2025-01-01T00:00:00Z',
            registryName: 'test',
            repository: 'app',
            compressedSizeBytes: 50,
          },
        ];

        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ tags: page1Tags }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ tags: page2Tags }),
          });

        const tags = await client.listTags('app');
        expect(tags).toHaveLength(101);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });

    describe('getLatestTag', () => {
      it('should return the most recently updated tag', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            tags: [
              { tag: 'v1.0', manifestDigest: 'sha1', sizeBytes: 100, updatedAt: '2025-01-01T00:00:00Z', registryName: 'test', repository: 'app', compressedSizeBytes: 50 },
              { tag: 'v2.0', manifestDigest: 'sha2', sizeBytes: 100, updatedAt: '2025-02-01T00:00:00Z', registryName: 'test', repository: 'app', compressedSizeBytes: 50 },
            ],
          }),
        });

        const latest = await client.getLatestTag('app');
        expect(latest?.tag).toBe('v2.0');
      });

      it('should return null when no tags exist', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tags: [] }),
        });

        const latest = await client.getLatestTag('app');
        expect(latest).toBeNull();
      });
    });

    describe('getManifestDigest', () => {
      it('should return digest for a specific tag', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            tags: [
              { tag: 'v1.0', manifestDigest: 'sha256:abc', sizeBytes: 100, updatedAt: '2025-01-01T00:00:00Z', registryName: 'test', repository: 'app', compressedSizeBytes: 50 },
            ],
          }),
        });

        const digest = await client.getManifestDigest('app', 'v1.0');
        expect(digest).toBe('sha256:abc');
      });

      it('should throw when tag is not found', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            tags: [
              { tag: 'v1.0', manifestDigest: 'sha256:abc', sizeBytes: 100, updatedAt: '2025-01-01T00:00:00Z', registryName: 'test', repository: 'app', compressedSizeBytes: 50 },
            ],
          }),
        });

        await expect(client.getManifestDigest('app', 'nonexistent'))
          .rejects.toThrow('Tag nonexistent not found');
      });
    });

    describe('getFullImageName', () => {
      it('should construct full image name with tag', () => {
        expect(client.getFullImageName('my-app', 'v1.0'))
          .toBe('registry.digitalocean.com/test-registry/my-app:v1.0');
      });

      it('should default tag to latest', () => {
        expect(client.getFullImageName('my-app'))
          .toBe('registry.digitalocean.com/test-registry/my-app:latest');
      });
    });
  });

  describe('DockerHubClient', () => {
    describe('testConnection', () => {
      it('should authenticate with token', async () => {
        const client = new DockerHubClient({ token: 'my-token' });
        // testConnection calls authenticate which for token just sets authToken
        await expect(client.testConnection()).resolves.toBeUndefined();
      });

      it('should authenticate with username/password', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ token: 'auth-token-from-login' }),
        });

        const client = new DockerHubClient({ username: 'user', password: 'pass' });
        await expect(client.testConnection()).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith(
          'https://hub.docker.com/v2/users/login/',
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it('should throw when no credentials provided', async () => {
        const client = new DockerHubClient({});
        await expect(client.testConnection()).rejects.toThrow('No credentials provided');
      });

      it('should throw on failed authentication', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
        });

        const client = new DockerHubClient({ username: 'user', password: 'wrong' });
        await expect(client.testConnection()).rejects.toThrow('authentication failed');
      });
    });

    describe('listTags', () => {
      it('should prepend library/ for official images', async () => {
        const client = new DockerHubClient({ token: 'my-token' });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            results: [
              { name: 'latest', digest: 'sha256:abc', full_size: 1024, last_updated: '2025-01-01T00:00:00Z' },
            ],
          }),
        });

        await client.listTags('nginx');

        // Should call with library/nginx
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('library/nginx'),
          expect.any(Object),
        );
      });

      it('should not prepend library/ for user repos', async () => {
        const client = new DockerHubClient({ token: 'my-token' });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            results: [
              { name: 'latest', digest: 'sha256:abc', full_size: 1024, last_updated: '2025-01-01T00:00:00Z' },
            ],
          }),
        });

        await client.listTags('myuser/myapp');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('myuser/myapp'),
          expect.any(Object),
        );
      });

      it('should map Docker Hub tag format to RegistryTag', async () => {
        const client = new DockerHubClient({ token: 'my-token' });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            results: [
              { name: 'v1.0', digest: 'sha256:abc', full_size: 2048, last_updated: '2025-02-01T00:00:00Z' },
            ],
          }),
        });

        const tags = await client.listTags('user/app');
        expect(tags).toEqual([
          { tag: 'v1.0', digest: 'sha256:abc', size: 2048, updatedAt: '2025-02-01T00:00:00Z' },
        ]);
      });
    });

    describe('listRepositories', () => {
      it('should throw when username is not set', async () => {
        const client = new DockerHubClient({ token: 'my-token' });
        await expect(client.listRepositories()).rejects.toThrow('Username required');
      });
    });
  });

  describe('GenericRegistryClient', () => {
    let client: GenericRegistryClient;

    beforeEach(() => {
      client = new GenericRegistryClient({
        registryUrl: 'https://my.registry.com',
        username: 'user',
        password: 'pass',
      });
    });

    describe('testConnection', () => {
      it('should check /v2/ endpoint', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await expect(client.testConnection()).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith(
          'https://my.registry.com/v2/',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expect.stringContaining('Basic'),
            }),
          }),
        );
      });

      it('should accept 401 as valid (auth required but accessible)', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
        await expect(client.testConnection()).resolves.toBeUndefined();
      });

      it('should throw on non-401 errors', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
        await expect(client.testConnection()).rejects.toThrow('Registry connection failed: 500');
      });
    });

    describe('listRepositories', () => {
      it('should return repositories from catalog', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ repositories: ['app', 'web'] }),
        });

        const repos = await client.listRepositories();
        expect(repos).toEqual([
          { name: 'app', tagCount: 0 },
          { name: 'web', tagCount: 0 },
        ]);
      });
    });

    describe('getManifestDigest', () => {
      it('should return Docker-Content-Digest header', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['Docker-Content-Digest', 'sha256:abc123']]),
        });

        // GenericRegistryClient.getManifestDigest calls response.headers.get()
        // which uses the Map-like interface. Need to mock properly.
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (name: string) => name === 'Docker-Content-Digest' ? 'sha256:abc123' : null,
          },
        });

        const digest = await client.getManifestDigest('app', 'v1.0');
        expect(digest).toBe('sha256:abc123');
      });

      it('should use HEAD method with correct Accept header', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'sha256:abc' },
        });

        await client.getManifestDigest('app', 'v1.0');

        expect(mockFetch).toHaveBeenCalledWith(
          'https://my.registry.com/v2/app/manifests/v1.0',
          expect.objectContaining({
            method: 'HEAD',
            headers: expect.objectContaining({
              Accept: expect.stringContaining('application/vnd.docker.distribution.manifest.v2+json'),
            }),
          }),
        );
      });

      it('should throw on manifest fetch failure', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        await expect(client.getManifestDigest('app', 'nonexistent'))
          .rejects.toThrow('Failed to get manifest: 404');
      });
    });

    describe('getLatestTag', () => {
      it('should prefer latest tag if it exists', async () => {
        // First mock: listTags calls /v2/{repo}/tags/list
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tags: ['v1.0', 'latest'] }),
        });
        // Then getManifestDigest is called for each tag
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'sha256:v1digest' },
          })
          .mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'sha256:latestdigest' },
          });

        const latest = await client.getLatestTag('app');
        expect(latest?.tag).toBe('latest');
      });
    });

    describe('auth header construction', () => {
      it('should use Basic auth when username and password provided', async () => {
        const authedClient = new GenericRegistryClient({
          registryUrl: 'https://my.registry.com',
          username: 'user',
          password: 'pass',
        });

        mockFetch.mockResolvedValueOnce({ ok: true });

        await authedClient.testConnection();

        const expectedAuth = 'Basic ' + Buffer.from('user:pass').toString('base64');
        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
          }),
        );
      });

      it('should not include auth header when no credentials', async () => {
        const noAuthClient = new GenericRegistryClient({
          registryUrl: 'https://public.registry.com',
        });

        mockFetch.mockResolvedValueOnce({ ok: true });

        await noAuthClient.testConnection();

        const callHeaders = mockFetch.mock.calls[0][1].headers;
        expect(callHeaders.Authorization).toBeUndefined();
      });
    });

    describe('registryUrl normalization', () => {
      it('should strip trailing slash from registryUrl', async () => {
        const trailingSlashClient = new GenericRegistryClient({
          registryUrl: 'https://my.registry.com/',
        });

        mockFetch.mockResolvedValueOnce({ ok: true });

        await trailingSlashClient.testConnection();

        expect(mockFetch).toHaveBeenCalledWith(
          'https://my.registry.com/v2/',
          expect.any(Object),
        );
      });
    });
  });
});
