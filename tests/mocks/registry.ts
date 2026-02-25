/**
 * Mock registry client for tests.
 *
 * Implements the RegistryClient interface from src/lib/registry.ts.
 */
import { vi } from 'vitest';
import type { RegistryClient, RegistryTag, RegistryRepository } from '../../src/lib/registry.js';

export interface MockRegistryOptions {
  /** Repositories and their tags */
  repositories?: Record<string, RegistryTag[]>;
  /** Whether testConnection should fail */
  connectionFailure?: string;
}

export function createMockRegistry(options: MockRegistryOptions = {}): RegistryClient & {
  /** Add a tag to a repository */
  addTag: (repo: string, tag: RegistryTag) => void;
  /** Set connection failure */
  setConnectionFailure: (error: string | null) => void;
  /** Mock functions for spying */
  calls: {
    testConnection: ReturnType<typeof vi.fn>;
    listRepositories: ReturnType<typeof vi.fn>;
    listTags: ReturnType<typeof vi.fn>;
    getLatestTag: ReturnType<typeof vi.fn>;
    getManifestDigest: ReturnType<typeof vi.fn>;
  };
} {
  const repositories = new Map<string, RegistryTag[]>(
    Object.entries(options.repositories || {})
  );
  let connectionFailure = options.connectionFailure || null;

  const testConnection = vi.fn(async (): Promise<void> => {
    if (connectionFailure) {
      throw new Error(connectionFailure);
    }
  });

  const listRepositories = vi.fn(async (): Promise<RegistryRepository[]> => {
    if (connectionFailure) throw new Error(connectionFailure);
    return Array.from(repositories.entries()).map(([name, tags]) => ({
      name,
      tagCount: tags.length,
    }));
  });

  const listTags = vi.fn(async (repo: string): Promise<RegistryTag[]> => {
    if (connectionFailure) throw new Error(connectionFailure);
    return repositories.get(repo) || [];
  });

  const getLatestTag = vi.fn(async (repo: string): Promise<RegistryTag | null> => {
    if (connectionFailure) throw new Error(connectionFailure);
    const tags = repositories.get(repo);
    if (!tags || tags.length === 0) return null;
    // Sort by updatedAt descending
    const sorted = [...tags].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return sorted[0];
  });

  const getManifestDigest = vi.fn(async (repo: string, tag: string): Promise<string> => {
    if (connectionFailure) throw new Error(connectionFailure);
    const tags = repositories.get(repo);
    const found = tags?.find((t) => t.tag === tag);
    if (!found) throw new Error(`Tag ${tag} not found in repository ${repo}`);
    return found.digest;
  });

  return {
    testConnection,
    listRepositories,
    listTags,
    getLatestTag,
    getManifestDigest,
    addTag: (repo: string, tag: RegistryTag) => {
      if (!repositories.has(repo)) {
        repositories.set(repo, []);
      }
      repositories.get(repo)!.push(tag);
    },
    setConnectionFailure: (error: string | null) => {
      connectionFailure = error;
    },
    calls: {
      testConnection,
      listRepositories,
      listTags,
      getLatestTag,
      getManifestDigest,
    },
  };
}
