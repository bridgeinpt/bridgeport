/**
 * Utilities for parsing Docker image names and extracting registry/repository information.
 */

export interface ParsedRegistry {
  registryUrl: string;
  isDockerHub: boolean;
}

/**
 * Parse registry URL from an image name.
 * Examples:
 *   registry.digitalocean.com/my-registry/my-app -> registry.digitalocean.com
 *   ghcr.io/owner/repo -> ghcr.io
 *   nginx -> docker.io (Docker Hub)
 *   caddy:2-alpine -> docker.io
 */
export function parseRegistryFromImage(imageName: string): ParsedRegistry {
  // Remove tag if present
  const nameWithoutTag = imageName.split(':')[0];
  const parts = nameWithoutTag.split('/');

  // Docker Hub images (official or user)
  if (parts.length === 1 || (parts.length === 2 && !parts[0].includes('.'))) {
    return { registryUrl: 'docker.io', isDockerHub: true };
  }

  // Private registry: first part contains a dot (domain)
  return { registryUrl: parts[0], isDockerHub: false };
}

/**
 * Extract just the image name (last path segment) from a full image path.
 * Examples:
 *   registry.digitalocean.com/my-registry/my-app -> app-api
 *   ghcr.io/owner/repo -> repo
 *   nginx -> nginx
 *   caddy:2-alpine -> caddy
 */
export function extractImageName(fullImagePath: string): string {
  // Remove tag if present
  const nameWithoutTag = fullImagePath.split(':')[0];
  const parts = nameWithoutTag.split('/');
  return parts[parts.length - 1];
}

/**
 * Extract repository name from full image name, optionally using a prefix pattern.
 * Examples (no prefix):
 *   registry.digitalocean.com/my-registry/my-app -> app-api
 *   ghcr.io/owner/repo -> repo
 * Examples (with prefix "my-registry"):
 *   registry.digitalocean.com/my-registry/my-app -> app-api
 */
export function extractRepoName(imageName: string, repositoryPrefix: string | null): string {
  // Remove registry domain and any prefix
  const parts = imageName.split('/');
  let repo = parts[parts.length - 1];

  // If there's a prefix pattern like "prefix/repo", handle it
  if (repositoryPrefix && parts.length > 1) {
    const prefixIdx = parts.findIndex((p) => p === repositoryPrefix);
    if (prefixIdx >= 0 && prefixIdx < parts.length - 1) {
      repo = parts.slice(prefixIdx + 1).join('/');
    }
  }

  return repo;
}

/**
 * Parse a comma-separated tag filter string into an array of glob patterns.
 * Trims whitespace from each pattern and filters out empty strings.
 */
export function parseTagFilter(tagFilter: string): string[] {
  return tagFilter
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check if a tag matches any of the given glob patterns.
 * Simple glob matching where `*` matches any sequence of [a-zA-Z0-9._-] chars.
 */
export function matchesTagFilter(tag: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Escape regex special chars, then replace * with character class
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '[a-zA-Z0-9._-]*');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(tag);
  });
}

/**
 * From a SHA's tag list, pick the best display tag.
 *
 * - If tags is empty, return null
 * - Separate tags into filter-matching and non-matching
 * - Among filter-matching: prefer most specific (longest string or most dot segments)
 * - If no filter matches: prefer semver-looking tags > named tags > `latest`
 * - Return the best one
 */
export function getBestTag(tags: string[], filterPatterns: string[]): string | null {
  if (tags.length === 0) return null;

  // Separate into filter-matching and non-matching
  const matching = tags.filter((t) => matchesTagFilter(t, filterPatterns));
  const nonMatching = tags.filter((t) => !matchesTagFilter(t, filterPatterns));

  if (matching.length > 0) {
    // Among filter matches, prefer most specific match:
    // 1. Tags matching a pattern without wildcards (exact match) rank higher
    // 2. Then most dot segments, then longest string
    const exactPatterns = filterPatterns.filter((p) => !p.includes('*'));
    return [...matching].sort((a, b) => {
      const aExact = exactPatterns.includes(a) ? 1 : 0;
      const bExact = exactPatterns.includes(b) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const dotsA = a.split('.').length;
      const dotsB = b.split('.').length;
      if (dotsA !== dotsB) return dotsB - dotsA;
      return b.length - a.length;
    })[0];
  }

  // No filter matches — rank by category
  const semverLike = nonMatching.filter((t) => /^v?\d/.test(t));
  const named = nonMatching.filter((t) => !/^v?\d/.test(t) && t !== 'latest');
  const latest = nonMatching.filter((t) => t === 'latest');

  if (semverLike.length > 0) return semverLike[0];
  if (named.length > 0) return named[0];
  if (latest.length > 0) return latest[0];

  return tags[0];
}

/**
 * Get the default tag from a tagFilter string (first pattern, trimmed).
 * Used as fallback when no bestTag is available from digests.
 */
export function getDefaultTag(tagFilter: string): string {
  return tagFilter.split(',')[0]?.trim() || 'latest';
}

/**
 * Format a digest for short display.
 * If the digest contains `sha256:`, extract the first 12 chars after the prefix.
 * Otherwise return the first 12 chars.
 */
export function formatDigestShort(digest: string): string {
  const sha256Prefix = 'sha256:';
  const hashPart = digest.includes(sha256Prefix)
    ? digest.slice(digest.indexOf(sha256Prefix) + sha256Prefix.length)
    : digest;
  return hashPart.slice(0, 12) || hashPart;
}

/**
 * Strip registry prefix from an image name to get the repository path.
 * Examples:
 *   registry.digitalocean.com/my-registry/my-app -> my-registry/my-app
 *   ghcr.io/owner/repo -> owner/repo
 *   nginx -> nginx
 */
export function stripRegistryPrefix(imageName: string): string {
  const nameWithoutTag = imageName.split(':')[0];
  const parts = nameWithoutTag.split('/');

  // Docker Hub images (official or user)
  if (parts.length === 1 || (parts.length === 2 && !parts[0].includes('.'))) {
    return nameWithoutTag;
  }

  // Private registry: remove the first part (domain)
  return parts.slice(1).join('/');
}
