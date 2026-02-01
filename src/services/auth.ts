import bcrypt from 'bcrypt';
import { prisma } from '../lib/db.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import type { User, ApiToken } from '@prisma/client';

const SALT_ROUNDS = 12;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export async function createUser(
  email: string,
  password: string,
  name?: string
): Promise<AuthUser> {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
    },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  return user;
}

export async function validatePassword(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return null;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
}

export async function getUserById(id: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  return user;
}

export async function createApiToken(
  userId: string,
  name: string,
  expiresAt?: Date
): Promise<{ token: string; tokenRecord: ApiToken }> {
  const token = generateToken();
  const tokenHashValue = hashToken(token);

  const tokenRecord = await prisma.apiToken.create({
    data: {
      name,
      tokenHash: tokenHashValue,
      expiresAt,
      userId,
    },
  });

  return { token, tokenRecord };
}

export async function validateApiToken(token: string): Promise<AuthUser | null> {
  const tokenHashValue = hashToken(token);

  const tokenRecord = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    include: { user: true },
  });

  if (!tokenRecord) {
    return null;
  }

  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
    return null;
  }

  // Update last used
  await prisma.apiToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    id: tokenRecord.user.id,
    email: tokenRecord.user.email,
    name: tokenRecord.user.name,
  };
}

export async function listApiTokens(userId: string): Promise<Omit<ApiToken, 'tokenHash'>[]> {
  const tokens = await prisma.apiToken.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      userId: true,
    },
  });

  return tokens;
}

export async function deleteApiToken(tokenId: string, userId: string): Promise<boolean> {
  const result = await prisma.apiToken.deleteMany({
    where: {
      id: tokenId,
      userId,
    },
  });

  return result.count > 0;
}

/**
 * Bootstrap initial admin user from environment variables.
 * Only creates the user if no users exist in the database.
 */
export async function bootstrapAdminUser(
  email: string | undefined,
  password: string | undefined
): Promise<void> {
  if (!email || !password) {
    return;
  }

  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return;
  }

  console.log(`Creating initial admin user: ${email}`);
  await createUser(email, password, 'Admin');
  console.log('Admin user created successfully');
}
