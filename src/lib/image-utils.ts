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
