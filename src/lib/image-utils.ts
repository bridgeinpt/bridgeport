/**
 * Utilities for parsing Docker image names and extracting registry/repository information.
 */

import type { RegistryTag } from './registry.js';

export interface ParsedRegistry {
  registryUrl: string;
  isDockerHub: boolean;
}

/**
 * Parse registry URL from an image name.
 * Examples:
 *   registry.digitalocean.com/bios-registry/app-api -> registry.digitalocean.com
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
 *   registry.digitalocean.com/bios-registry/app-api -> app-api
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
 *   registry.digitalocean.com/bios-registry/app-api -> app-api
 *   ghcr.io/owner/repo -> repo
 * Examples (with prefix "bios-registry"):
 *   registry.digitalocean.com/bios-registry/app-api -> app-api
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
 * Well-known rolling/special tags that should only match themselves exactly.
 */
const SPECIAL_TAGS = new Set([
  'latest', 'stable', 'edge', 'nightly', 'beta', 'alpha', 'rc', 'lts',
  'mainline', 'development', 'testing', 'production',
]);

/**
 * Extract the "family" suffix from a Docker tag.
 *
 * A tag's family is its non-version suffix. Tags in the same family differ
 * only by version number:
 *   "2-alpine"       -> "-alpine"
 *   "2.9.0-alpine"   -> "-alpine"
 *   "2.9.0"          -> ""         (pure version)
 *   "latest"         -> "=latest"  (exact-match family)
 *   "3.19-slim-bookworm" -> "-slim-bookworm"
 *   "bookworm"       -> "=bookworm" (no version prefix, exact match)
 */
export function getTagFamily(tag: string): string {
  // Special rolling tags get exact-match families
  if (SPECIAL_TAGS.has(tag.toLowerCase())) {
    return `=${tag.toLowerCase()}`;
  }

  // Try to match version prefix: optional 'v', then digits with dots, then optional suffix
  const match = tag.match(/^v?(\d+\.)*\d+(-.+)?$/);
  if (match) {
    // match[2] is the "-suffix" part (e.g., "-alpine"), or undefined for pure versions
    return match[2] || '';
  }

  // No version prefix found — treat as exact-match family (e.g., "bookworm", "noble")
  return `=${tag.toLowerCase()}`;
}

/**
 * Filter a list of registry tags to those matching the same family as currentTag.
 */
export function filterTagsByFamily(tags: RegistryTag[], currentTag: string): RegistryTag[] {
  const family = getTagFamily(currentTag);

  return tags.filter((t) => getTagFamily(t.tag) === family);
}

/**
 * From a pre-fetched tag list, find the latest tag in the same family as currentTag.
 * Also extracts the current tag's digest. This replaces two separate API calls
 * (getLatestTag + getManifestDigest) with one (listTags).
 */
export function findLatestInFamily(
  allTags: RegistryTag[],
  currentTag: string
): { latestTag: RegistryTag | null; currentDigest: string | null } {
  const familyTags = filterTagsByFamily(allTags, currentTag);

  // Find current tag's digest
  const currentEntry = allTags.find((t) => t.tag === currentTag);
  const currentDigest = currentEntry?.digest || null;

  if (familyTags.length === 0) {
    return { latestTag: null, currentDigest };
  }

  // Sort by updatedAt descending to find the most recently updated tag in the family
  const sorted = [...familyTags].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return { latestTag: sorted[0], currentDigest };
}

/**
 * Find a "companion" tag that shares the same digest as the given tag.
 * Useful for rolling tags like "latest" — finds the concrete build tag
 * (e.g., "20260223-30a4f0b") that the rolling tag currently points to.
 *
 * Returns the best non-rolling companion tag, or null if none found.
 */
export function findCompanionTag(
  allTags: RegistryTag[],
  currentTag: string,
  currentDigest: string
): string | null {
  // Find all tags sharing the same digest, excluding the current tag
  const companions = allTags.filter(
    (t) => t.digest === currentDigest && t.tag !== currentTag
  );

  if (companions.length === 0) return null;

  // Prefer non-rolling tags (build/version tags) over rolling tags
  const nonRolling = companions.filter(
    (t) => !SPECIAL_TAGS.has(t.tag.toLowerCase())
  );

  if (nonRolling.length > 0) {
    // Sort by updatedAt descending, return the most recent
    nonRolling.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return nonRolling[0].tag;
  }

  // Fall back to the first companion (even if it's a rolling tag)
  return companions[0].tag;
}

/**
 * Strip registry prefix from an image name to get the repository path.
 * Examples:
 *   registry.digitalocean.com/bios-registry/app-api -> bios-registry/app-api
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
