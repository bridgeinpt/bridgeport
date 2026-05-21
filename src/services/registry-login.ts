import { prisma } from '../lib/db.js';
import type { DockerSSH } from '../lib/ssh.js';
import { getRegistryCredentials, type RegistryCredentials } from './registries.js';

export interface DockerLoginArgs {
  registryHost: string; // empty string => Docker Hub
  username: string;
  password: string;
}

/**
 * Translate stored registry credentials into the (host, username, password) tuple
 * `docker login` expects. Returns null when the credentials lack the fields needed
 * to authenticate (e.g. a generic registry with no username/password — anonymous).
 */
export function toDockerLoginArgs(creds: RegistryCredentials): DockerLoginArgs | null {
  switch (creds.type) {
    case 'digitalocean': {
      // DOCR accepts the API token as both username and password.
      if (!creds.token) return null;
      return {
        registryHost: 'registry.digitalocean.com',
        username: creds.token,
        password: creds.token,
      };
    }
    case 'dockerhub': {
      const username = creds.username;
      const password = creds.token || creds.password;
      if (!username || !password) return null;
      // Empty host => docker login defaults to Docker Hub (index.docker.io).
      return { registryHost: '', username, password };
    }
    case 'generic': {
      const username = creds.username;
      const password = creds.password || creds.token;
      if (!username || !password) return null;
      return {
        registryHost: normalizeRegistryHost(creds.registryUrl),
        username,
        password,
      };
    }
    default:
      return null;
  }
}

/**
 * Reduce a stored registry URL down to the hostname `docker login` wants.
 * Strips scheme, trailing slash, and a trailing `/v2` (the V2 API suffix the
 * generic client uses internally but docker login does not accept).
 */
export function normalizeRegistryHost(registryUrl: string): string {
  return registryUrl
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\/v2$/, '');
}

export type EnsureLoginResult =
  | { loggedIn: false; reason: 'fresh' | 'no-credentials' | 'registry-not-found' }
  | { loggedIn: true; reason: 'logged-in'; registryHost: string };

/**
 * Ensure `serverId` is logged into `registryConnectionId` before a pull.
 *
 * No-op when a ServerRegistryLogin row exists and is at least as fresh as the
 * RegistryConnection's `updatedAt` — that means we logged in after the most
 * recent credential change, so the persistent ~/.docker/config.json on the
 * server is still valid.
 *
 * Otherwise: runs `docker login` via the provided DockerSSH client and upserts
 * the row. Throws on failure so the deploy fails loudly instead of falling
 * through to a misleading "image not found" later.
 */
export async function ensureRegistryLogin(
  serverId: string,
  registryConnectionId: string,
  docker: DockerSSH
): Promise<EnsureLoginResult> {
  const connection = await prisma.registryConnection.findUnique({
    where: { id: registryConnectionId },
    select: { id: true, updatedAt: true },
  });
  if (!connection) {
    return { loggedIn: false, reason: 'registry-not-found' };
  }

  const credentials = await getRegistryCredentials(registryConnectionId);
  if (!credentials) {
    return { loggedIn: false, reason: 'registry-not-found' };
  }

  const loginArgs = toDockerLoginArgs(credentials);
  if (!loginArgs) {
    // Anonymous / unsupported credentials shape — leave docker to attempt the pull as-is.
    return { loggedIn: false, reason: 'no-credentials' };
  }

  const existing = await prisma.serverRegistryLogin.findUnique({
    where: {
      serverId_registryConnectionId: { serverId, registryConnectionId },
    },
  });

  if (existing && existing.loggedInAt.getTime() >= connection.updatedAt.getTime()) {
    return { loggedIn: false, reason: 'fresh' };
  }

  await docker.login(loginArgs.registryHost, loginArgs.username, loginArgs.password);

  await prisma.serverRegistryLogin.upsert({
    where: {
      serverId_registryConnectionId: { serverId, registryConnectionId },
    },
    create: { serverId, registryConnectionId, loggedInAt: new Date() },
    update: { loggedInAt: new Date() },
  });

  return { loggedIn: true, reason: 'logged-in', registryHost: loginArgs.registryHost };
}

/**
 * Look up the credentials for a registry connection and translate them into the
 * authconfig shape dockerode's `pull()` expects. Used by socket-mode deploys
 * where no remote `docker login` is possible — auth is passed in-process per pull.
 */
export async function getSocketAuthConfig(
  registryConnectionId: string
): Promise<{ username: string; password: string; serveraddress: string } | null> {
  const creds = await getRegistryCredentials(registryConnectionId);
  if (!creds) return null;
  const args = toDockerLoginArgs(creds);
  if (!args) return null;
  return {
    username: args.username,
    password: args.password,
    serveraddress: args.registryHost,
  };
}

/**
 * Drop all login state for a registry. Called when its stored credentials
 * change so the next deploy re-runs `docker login` with the new values.
 */
export async function invalidateRegistryLogins(registryConnectionId: string): Promise<void> {
  await prisma.serverRegistryLogin.deleteMany({
    where: { registryConnectionId },
  });
}
