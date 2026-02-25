import { getSystemSettings } from '../services/system-settings.js';

// Common types
export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  updatedAt: string;
}

export interface RegistryRepository {
  name: string;
  tagCount: number;
}

export interface RegistryClient {
  testConnection(): Promise<void>;
  listRepositories(): Promise<RegistryRepository[]>;
  listTags(repo: string): Promise<RegistryTag[]>;
  getLatestTag(repo: string): Promise<RegistryTag | null>;
  getManifestDigest(repo: string, tag: string): Promise<string>;
}

export interface RegistryCredentials {
  type: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  token?: string;
  username?: string;
  password?: string;
}

// DigitalOcean Registry Client
const DO_REGISTRY_API = 'https://api.digitalocean.com/v2/registry';

interface DORegistryTag {
  registryName: string;
  repository: string;
  tag: string;
  manifestDigest: string;
  compressedSizeBytes: number;
  sizeBytes: number;
  updatedAt: string;
}

interface DORegistryRepository {
  registryName: string;
  name: string;
  latestTag: DORegistryTag;
  tagCount: number;
}

export class DORegistryClient implements RegistryClient {
  private token: string;
  private registryName: string;
  private dockerCreds?: { username: string; password: string };

  constructor(token: string, registryName: string = 'bios-registry') {
    this.token = token;
    this.registryName = registryName;
  }

  private async fetch<T>(path: string): Promise<T> {
    const response = await fetch(`${DO_REGISTRY_API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Registry API error: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<void> {
    await this.fetch<{ registry: { name: string } }>('');
  }

  async listRepositories(): Promise<RegistryRepository[]> {
    const data = await this.fetch<{ repositories: DORegistryRepository[] }>(
      `/${this.registryName}/repositoriesV2`
    );
    return data.repositories.map((r) => ({
      name: r.name,
      tagCount: r.tagCount,
    }));
  }

  async listTags(repositoryName: string): Promise<RegistryTag[]> {
    // Fetch with pagination - DO API defaults to 20 per page
    const allTags: RegistryTag[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const data = await this.fetch<{ tags: DORegistryTag[]; meta?: { total: number } }>(
        `/${this.registryName}/repositories/${repositoryName}/tags?per_page=${perPage}&page=${page}`
      );

      for (const t of data.tags) {
        // Handle both camelCase and snake_case responses from DO API
        const raw = t as DORegistryTag & Record<string, unknown>;
        allTags.push({
          tag: t.tag,
          digest: t.manifestDigest || (raw.manifest_digest as string) || '',
          size: t.sizeBytes || (raw.size_bytes as number) || 0,
          updatedAt: t.updatedAt || (raw.updated_at as string) || '',
        });
      }

      // Stop if we got fewer than requested (last page)
      if (data.tags.length < perPage) break;
      page++;
    }

    // Fill in missing digests from Docker Registry V2 API
    const tagsNeedingDigest = allTags.filter((t) => !t.digest);
    if (tagsNeedingDigest.length > 0) {
      try {
        const creds = await this.getDockerCredentials();
        this.dockerCreds = creds;
        const batchSize = 10;

        for (let i = 0; i < tagsNeedingDigest.length; i += batchSize) {
          const batch = tagsNeedingDigest.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map((t) => this.fetchV2ManifestDigest(repositoryName, t.tag))
          );

          for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
              batch[j].digest = (results[j] as PromiseFulfilledResult<string>).value;
            }
          }
        }
      } catch (err) {
        console.warn('[DORegistry] Failed to fetch Docker credentials for V2 digest fallback:', err);
      }
    }

    return allTags;
  }

  /**
   * Fetch manifest digest from the Docker Registry V2 API (registry.digitalocean.com)
   * Used as fallback when the DO management API doesn't return digests.
   */
  private async fetchV2ManifestDigest(repo: string, tag: string): Promise<string> {
    if (!this.dockerCreds) {
      this.dockerCreds = await this.getDockerCredentials();
    }

    const auth = Buffer.from(`${this.dockerCreds.username}:${this.dockerCreds.password}`).toString('base64');
    const fullRepo = `${this.registryName}/${repo}`;

    const response = await fetch(
      `https://registry.digitalocean.com/v2/${fullRepo}/manifests/${tag}`,
      {
        method: 'HEAD',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: [
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.index.v1+json',
          ].join(', '),
        },
      }
    );

    if (!response.ok) {
      throw new Error(`V2 manifest fetch failed: ${response.status}`);
    }

    return response.headers.get('Docker-Content-Digest') || '';
  }

  async getLatestTag(repositoryName: string): Promise<RegistryTag | null> {
    const tags = await this.listTags(repositoryName);
    if (tags.length === 0) return null;

    // Sort by updated date descending
    tags.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return tags[0];
  }

  async getManifestDigest(repositoryName: string, tag: string): Promise<string> {
    // First try V2 API directly for the most accurate digest
    try {
      return await this.fetchV2ManifestDigest(repositoryName, tag);
    } catch {
      // Fall back to DO management API
      const tags = await this.listTags(repositoryName);
      const found = tags.find((t) => t.tag === tag);
      if (!found) {
        throw new Error(`Tag ${tag} not found in repository ${repositoryName}`);
      }
      return found.digest;
    }
  }

  async getDockerCredentials(): Promise<{ username: string; password: string }> {
    const data = await this.fetch<{
      auths: { 'registry.digitalocean.com': { auth: string } };
    }>('/docker-credentials');

    const auth = data.auths['registry.digitalocean.com'].auth;
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const [username, password] = decoded.split(':');

    return { username, password };
  }

  getFullImageName(repositoryName: string, tag: string = 'latest'): string {
    return `registry.digitalocean.com/${this.registryName}/${repositoryName}:${tag}`;
  }
}

// Docker Hub Registry Client
export class DockerHubClient implements RegistryClient {
  private token?: string;
  private username?: string;
  private password?: string;
  private authToken?: string;

  constructor(options: { token?: string; username?: string; password?: string }) {
    this.token = options.token;
    this.username = options.username;
    this.password = options.password;
  }

  private hasCredentials(): boolean {
    return !!(this.token || (this.username && this.password));
  }

  private async authenticate(): Promise<string> {
    if (this.authToken) return this.authToken;

    if (this.token) {
      this.authToken = this.token;
      return this.authToken;
    }

    if (this.username && this.password) {
      const response = await fetch('https://hub.docker.com/v2/users/login/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
      });

      if (!response.ok) {
        throw new Error('Docker Hub authentication failed');
      }

      const data = (await response.json()) as { token: string };
      this.authToken = data.token;
      return this.authToken;
    }

    throw new Error('No credentials provided for Docker Hub');
  }

  private async fetch<T>(url: string, authenticated = true): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authenticated) {
      headers['Authorization'] = `Bearer ${await this.authenticate()}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Docker Hub API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<void> {
    await this.authenticate();
  }

  async listRepositories(): Promise<RegistryRepository[]> {
    if (!this.username) {
      throw new Error('Username required to list repositories');
    }

    const data = await this.fetch<{
      results: Array<{ name: string }>;
    }>(`https://hub.docker.com/v2/repositories/${this.username}/`);

    return data.results.map((r) => ({
      name: r.name,
      tagCount: 0, // Would need additional API call
    }));
  }

  async listTags(repo: string): Promise<RegistryTag[]> {
    // Repo might be:
    // - just name (official image) -> library/name
    // - user/name -> user/name as-is
    const fullRepo = repo.includes('/') ? repo : `library/${repo}`;

    // Official images (library/*) are public, don't need auth
    const needsAuth = !fullRepo.startsWith('library/') && this.hasCredentials();

    const data = await this.fetch<{
      results: Array<{
        name: string;
        digest: string;
        full_size: number;
        last_updated: string;
      }>;
    }>(`https://hub.docker.com/v2/repositories/${fullRepo}/tags?page_size=100`, needsAuth);

    return data.results.map((t) => ({
      tag: t.name,
      digest: t.digest || '',
      size: t.full_size,
      updatedAt: t.last_updated,
    }));
  }

  async getLatestTag(repo: string): Promise<RegistryTag | null> {
    const tags = await this.listTags(repo);
    if (tags.length === 0) return null;

    // Sort by updated date descending
    tags.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return tags[0];
  }

  async getManifestDigest(repo: string, tag: string): Promise<string> {
    const tags = await this.listTags(repo);
    const found = tags.find((t) => t.tag === tag);
    if (!found) {
      throw new Error(`Tag ${tag} not found in repository ${repo}`);
    }
    return found.digest;
  }
}

// Generic Docker Registry V2 Client
export class GenericRegistryClient implements RegistryClient {
  private registryUrl: string;
  private username?: string;
  private password?: string;

  constructor(options: {
    registryUrl: string;
    username?: string;
    password?: string;
  }) {
    this.registryUrl = options.registryUrl.replace(/\/$/, '');
    this.username = options.username;
    this.password = options.password;
  }

  private getAuthHeader(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.username && this.password) {
      const auth = Buffer.from(`${this.username}:${this.password}`).toString(
        'base64'
      );
      headers['Authorization'] = `Basic ${auth}`;
    }
    return headers;
  }

  private async fetch<T>(path: string): Promise<T> {
    const response = await fetch(`${this.registryUrl}${path}`, {
      headers: {
        Accept: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.index.v1+json',
        ].join(', '),
        ...this.getAuthHeader(),
      },
    });

    if (!response.ok) {
      throw new Error(`Registry API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<void> {
    const response = await fetch(`${this.registryUrl}/v2/`, {
      headers: this.getAuthHeader(),
    });

    if (!response.ok && response.status !== 401) {
      throw new Error(`Registry connection failed: ${response.status}`);
    }
  }

  async listRepositories(): Promise<RegistryRepository[]> {
    const data = await this.fetch<{ repositories: string[] }>('/v2/_catalog');
    return data.repositories.map((name) => ({
      name,
      tagCount: 0,
    }));
  }

  async listTags(repo: string): Promise<RegistryTag[]> {
    const data = await this.fetch<{ tags: string[] | null }>(`/v2/${repo}/tags/list`);
    if (!data.tags) return [];

    // Get max tags from system settings
    const settings = await getSystemSettings();
    const maxTags = settings.registryMaxTags;

    // Fetch manifest digests in parallel (batches of 10)
    const tagsToFetch = data.tags.slice(0, maxTags);
    const batchSize = 10;
    const tags: RegistryTag[] = [];

    for (let i = 0; i < tagsToFetch.length; i += batchSize) {
      const batch = tagsToFetch.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (tag) => {
          const digest = await this.getManifestDigest(repo, tag);
          return { tag, digest };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          tags.push({
            tag: result.value.tag,
            digest: result.value.digest,
            size: 0,
            updatedAt: new Date().toISOString(),
          });
        } else {
          // Extract tag name from the batch by index
          const idx = results.indexOf(result);
          tags.push({
            tag: batch[idx],
            digest: '',
            size: 0,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    return tags;
  }

  async getLatestTag(repo: string): Promise<RegistryTag | null> {
    const tags = await this.listTags(repo);
    if (tags.length === 0) return null;

    // For generic registries, prefer 'latest' tag if it exists
    const latest = tags.find((t) => t.tag === 'latest');
    if (latest) return latest;

    return tags[0];
  }

  async getManifestDigest(repo: string, tag: string): Promise<string> {
    // Try multiple manifest types — registries vary in what they support
    const response = await fetch(`${this.registryUrl}/v2/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        Accept: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.index.v1+json',
        ].join(', '),
        ...this.getAuthHeader(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get manifest: ${response.status}`);
    }

    return response.headers.get('Docker-Content-Digest') || '';
  }
}

// Factory for creating registry clients
export class RegistryFactory {
  static create(creds: RegistryCredentials): RegistryClient {
    switch (creds.type) {
      case 'digitalocean':
        if (!creds.token) {
          throw new Error('Token required for DigitalOcean registry');
        }
        return new DORegistryClient(creds.token, creds.repositoryPrefix || 'bios-registry');

      case 'dockerhub':
        return new DockerHubClient({
          token: creds.token,
          username: creds.username,
          password: creds.password,
        });

      case 'generic':
        return new GenericRegistryClient({
          registryUrl: creds.registryUrl,
          username: creds.username,
          password: creds.password,
        });

      default:
        throw new Error(`Unsupported registry type: ${creds.type}`);
    }
  }
}
