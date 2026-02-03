import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export interface RegistryConnectionInput {
  name: string;
  type: 'digitalocean' | 'dockerhub' | 'generic';
  registryUrl: string;
  repositoryPrefix?: string | null;
  token?: string | null;
  username?: string | null;
  password?: string | null;
  isDefault?: boolean;
  refreshIntervalMinutes?: number;
  autoLinkPattern?: string | null;
}

export interface RegistryConnectionOutput {
  id: string;
  name: string;
  type: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  hasToken: boolean;
  hasPassword: boolean;
  username: string | null;
  isDefault: boolean;
  refreshIntervalMinutes: number;
  autoLinkPattern: string | null;
  lastRefreshAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { containerImages: number };
}

function toOutput(conn: {
  id: string;
  name: string;
  type: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  encryptedToken: string | null;
  username: string | null;
  encryptedPassword: string | null;
  isDefault: boolean;
  refreshIntervalMinutes: number;
  autoLinkPattern: string | null;
  lastRefreshAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { containerImages: number };
}): RegistryConnectionOutput {
  return {
    id: conn.id,
    name: conn.name,
    type: conn.type,
    registryUrl: conn.registryUrl,
    repositoryPrefix: conn.repositoryPrefix,
    hasToken: !!conn.encryptedToken,
    hasPassword: !!conn.encryptedPassword,
    username: conn.username,
    isDefault: conn.isDefault,
    refreshIntervalMinutes: conn.refreshIntervalMinutes,
    autoLinkPattern: conn.autoLinkPattern,
    lastRefreshAt: conn.lastRefreshAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    environmentId: conn.environmentId,
    _count: conn._count,
  };
}

export async function createRegistryConnection(
  environmentId: string,
  input: RegistryConnectionInput
): Promise<RegistryConnectionOutput> {
  // If this is set as default, unset other defaults in this environment
  if (input.isDefault) {
    await prisma.registryConnection.updateMany({
      where: { environmentId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const data: {
    name: string;
    type: string;
    registryUrl: string;
    repositoryPrefix?: string;
    encryptedToken?: string;
    tokenNonce?: string;
    username?: string;
    encryptedPassword?: string;
    passwordNonce?: string;
    isDefault: boolean;
    refreshIntervalMinutes?: number;
    autoLinkPattern?: string;
    environmentId: string;
  } = {
    name: input.name,
    type: input.type,
    registryUrl: input.registryUrl,
    repositoryPrefix: input.repositoryPrefix || undefined,
    isDefault: input.isDefault ?? false,
    refreshIntervalMinutes: input.refreshIntervalMinutes ?? 30,
    autoLinkPattern: input.autoLinkPattern || undefined,
    environmentId,
  };

  if (input.token) {
    const { ciphertext, nonce } = encrypt(input.token);
    data.encryptedToken = ciphertext;
    data.tokenNonce = nonce;
  }

  if (input.username) {
    data.username = input.username;
  }

  if (input.password) {
    const { ciphertext, nonce } = encrypt(input.password);
    data.encryptedPassword = ciphertext;
    data.passwordNonce = nonce;
  }

  const conn = await prisma.registryConnection.create({
    data,
    include: { _count: { select: { containerImages: true } } },
  });

  return toOutput(conn);
}

export async function updateRegistryConnection(
  id: string,
  input: Partial<RegistryConnectionInput>
): Promise<RegistryConnectionOutput> {
  const existing = await prisma.registryConnection.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error('Registry connection not found');
  }

  // If this is set as default, unset other defaults in this environment
  if (input.isDefault) {
    await prisma.registryConnection.updateMany({
      where: { environmentId: existing.environmentId, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const data: {
    name?: string;
    type?: string;
    registryUrl?: string;
    repositoryPrefix?: string | null;
    encryptedToken?: string | null;
    tokenNonce?: string | null;
    username?: string | null;
    encryptedPassword?: string | null;
    passwordNonce?: string | null;
    isDefault?: boolean;
    refreshIntervalMinutes?: number;
    autoLinkPattern?: string | null;
  } = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.type !== undefined) data.type = input.type;
  if (input.registryUrl !== undefined) data.registryUrl = input.registryUrl;
  if (input.repositoryPrefix !== undefined) data.repositoryPrefix = input.repositoryPrefix;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  if (input.refreshIntervalMinutes !== undefined) data.refreshIntervalMinutes = input.refreshIntervalMinutes;
  if (input.autoLinkPattern !== undefined) data.autoLinkPattern = input.autoLinkPattern;

  if (input.token !== undefined) {
    if (input.token) {
      const { ciphertext, nonce } = encrypt(input.token);
      data.encryptedToken = ciphertext;
      data.tokenNonce = nonce;
    } else {
      data.encryptedToken = null;
      data.tokenNonce = null;
    }
  }

  if (input.username !== undefined) {
    data.username = input.username || null;
  }

  if (input.password !== undefined) {
    if (input.password) {
      const { ciphertext, nonce } = encrypt(input.password);
      data.encryptedPassword = ciphertext;
      data.passwordNonce = nonce;
    } else {
      data.encryptedPassword = null;
      data.passwordNonce = null;
    }
  }

  const conn = await prisma.registryConnection.update({
    where: { id },
    data,
    include: { _count: { select: { containerImages: true } } },
  });

  return toOutput(conn);
}

export async function getRegistryConnection(id: string): Promise<RegistryConnectionOutput | null> {
  const conn = await prisma.registryConnection.findUnique({
    where: { id },
    include: { _count: { select: { containerImages: true } } },
  });

  return conn ? toOutput(conn) : null;
}

export async function listRegistryConnections(environmentId: string): Promise<RegistryConnectionOutput[]> {
  const conns = await prisma.registryConnection.findMany({
    where: { environmentId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { containerImages: true } } },
  });

  return conns.map(toOutput);
}

export async function deleteRegistryConnection(id: string): Promise<void> {
  await prisma.registryConnection.delete({
    where: { id },
  });
}

export async function getDefaultRegistryConnection(environmentId: string): Promise<RegistryConnectionOutput | null> {
  const conn = await prisma.registryConnection.findFirst({
    where: { environmentId, isDefault: true },
    include: { _count: { select: { containerImages: true } } },
  });

  return conn ? toOutput(conn) : null;
}

export interface RegistryCredentials {
  type: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  token?: string;
  username?: string;
  password?: string;
}

export async function getRegistryCredentials(id: string): Promise<RegistryCredentials | null> {
  const conn = await prisma.registryConnection.findUnique({
    where: { id },
  });

  if (!conn) return null;

  const creds: RegistryCredentials = {
    type: conn.type,
    registryUrl: conn.registryUrl,
    repositoryPrefix: conn.repositoryPrefix,
  };

  if (conn.encryptedToken && conn.tokenNonce) {
    creds.token = decrypt(conn.encryptedToken, conn.tokenNonce);
  }

  if (conn.username) {
    creds.username = conn.username;
  }

  if (conn.encryptedPassword && conn.passwordNonce) {
    creds.password = decrypt(conn.encryptedPassword, conn.passwordNonce);
  }

  return creds;
}
