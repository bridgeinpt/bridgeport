import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db.js';
import { generateApiToken, hashToken } from '../lib/crypto.js';
import { hasMinimumRole } from '../plugins/authorize.js';
import { apiTokenLastUsedThrottle } from '../lib/last-active-throttle.js';
import { config } from '../lib/config.js';
import type { User, ApiToken } from '@prisma/client';

const SALT_ROUNDS = config.BCRYPT_ROUNDS;

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  // Set when the request was authenticated via an API token (vs. JWT session).
  // Subsequent authz middleware uses this to enforce environment scoping
  // and to attribute audit logs to the originating token.
  apiTokenId?: string;
  // Set when the actor is a service account (not a real user).
  serviceAccountId?: string;
  // Token-level environment scope. When allEnvironments is false, only the
  // listed environment IDs are accessible. Undefined for JWT sessions.
  scope?: {
    allEnvironments: boolean;
    environmentIds: string[];
  };
}

// For service-account-owned tokens, AuthUser.id is the `sa:<id>` sentinel and
// is NOT a valid User.id — writing it into a User foreign-key column would
// trigger an FK violation. Use this helper for any Prisma write into a User FK
// so SA-owned tokens fall through to a null actor (the audit log keeps the
// real attribution via apiTokenId/serviceAccountId).
export function userIdForFk(authUser: AuthUser): string | null {
  return authUser.serviceAccountId ? null : authUser.id;
}

export async function createUser(
  email: string,
  password: string,
  name?: string,
  role: UserRole = 'viewer'
): Promise<AuthUser> {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
    },
  });

  return user as AuthUser;
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
    role: user.role as UserRole,
  };
}

export async function getUserById(id: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
    },
  });

  if (!user) {
    return null;
  }

  return user as AuthUser;
}

export interface TokenScopeInput {
  role: UserRole;
  allEnvironments: boolean;
  environmentIds?: string[];
  expiresAt?: Date | null;
}

export interface CreateTokenInput extends TokenScopeInput {
  name: string;
  ownerUserId?: string;
  ownerServiceAccountId?: string;
}

async function resolveOwnerRole(input: {
  ownerUserId?: string;
  ownerServiceAccountId?: string;
}): Promise<UserRole | null> {
  if (input.ownerUserId) {
    const user = await prisma.user.findUnique({
      where: { id: input.ownerUserId },
      select: { role: true },
    });
    return (user?.role as UserRole) ?? null;
  }
  if (input.ownerServiceAccountId) {
    const sa = await prisma.serviceAccount.findUnique({
      where: { id: input.ownerServiceAccountId },
      select: { role: true, disabled: true },
    });
    if (!sa || sa.disabled) return null;
    return sa.role as UserRole;
  }
  return null;
}

export async function createApiToken(
  input: CreateTokenInput
): Promise<{ token: string; tokenRecord: ApiToken }> {
  if (!input.ownerUserId && !input.ownerServiceAccountId) {
    throw new Error('Token must have an owner (user or service account)');
  }
  if (input.ownerUserId && input.ownerServiceAccountId) {
    throw new Error('Token cannot have both a user and a service account owner');
  }

  const ownerRole = await resolveOwnerRole(input);
  if (!ownerRole) {
    throw new Error('Owner not found or disabled');
  }
  if (!hasMinimumRole(ownerRole, input.role)) {
    throw new Error(`Token role (${input.role}) exceeds owner role (${ownerRole})`);
  }

  const envIds = input.allEnvironments ? [] : input.environmentIds ?? [];
  if (!input.allEnvironments && envIds.length === 0) {
    throw new Error('Specific-environments scope requires at least one environment ID');
  }

  const { token, displayPrefix } = generateApiToken();
  const tokenHashValue = hashToken(token);

  const tokenRecord = await prisma.apiToken.create({
    data: {
      name: input.name,
      tokenHash: tokenHashValue,
      tokenPrefix: displayPrefix,
      role: input.role,
      allEnvironments: input.allEnvironments,
      expiresAt: input.expiresAt ?? null,
      userId: input.ownerUserId ?? null,
      serviceAccountId: input.ownerServiceAccountId ?? null,
      environments: envIds.length
        ? { create: envIds.map((environmentId) => ({ environmentId })) }
        : undefined,
    },
  });

  return { token, tokenRecord };
}

export async function validateApiToken(token: string): Promise<AuthUser | null> {
  const tokenHashValue = hashToken(token);

  const tokenRecord = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    include: {
      user: true,
      serviceAccount: true,
      environments: { select: { environmentId: true } },
    },
  });

  if (!tokenRecord) {
    return null;
  }

  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
    return null;
  }

  // Service-account tokens are inert if the SA is disabled.
  if (tokenRecord.serviceAccount?.disabled) {
    return null;
  }

  // Effective role = min(token role, owner role) — guards against role drift after token mint.
  const ownerRole = (tokenRecord.user?.role ?? tokenRecord.serviceAccount?.role) as UserRole | undefined;
  const tokenRole = tokenRecord.role as UserRole;
  if (!ownerRole) return null;
  const effectiveRole: UserRole = hasMinimumRole(ownerRole, tokenRole) ? tokenRole : ownerRole;

  // Update last used (fire-and-forget; don't block auth). Throttled per
  // tokenId — at 500+ RPS this write would otherwise hammer SQLite's
  // writer lock and spill latency into every authenticated read.
  if (apiTokenLastUsedThrottle.shouldWrite(tokenRecord.id)) {
    prisma.apiToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});
  }

  const scope = {
    allEnvironments: tokenRecord.allEnvironments,
    environmentIds: tokenRecord.environments.map((e) => e.environmentId),
  };

  if (tokenRecord.user) {
    return {
      id: tokenRecord.user.id,
      email: tokenRecord.user.email,
      name: tokenRecord.user.name,
      role: effectiveRole,
      apiTokenId: tokenRecord.id,
      scope,
    };
  }

  // Service-account-owned token: synthesize an AuthUser for downstream code.
  // Use a sentinel id so anything that compares against User.id can't accidentally match.
  return {
    id: `sa:${tokenRecord.serviceAccount!.id}`,
    email: `${tokenRecord.serviceAccount!.name}@service-account.local`,
    name: tokenRecord.serviceAccount!.name,
    role: effectiveRole,
    apiTokenId: tokenRecord.id,
    serviceAccountId: tokenRecord.serviceAccount!.id,
    scope,
  };
}

export interface ListTokensFilters {
  userId?: string;
  serviceAccountId?: string;
}

export async function listApiTokens(filters: ListTokensFilters = {}) {
  return prisma.apiToken.findMany({
    where: {
      userId: filters.userId,
      serviceAccountId: filters.serviceAccountId,
    },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      role: true,
      allEnvironments: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      userId: true,
      serviceAccountId: true,
      user: { select: { id: true, email: true, name: true } },
      serviceAccount: { select: { id: true, name: true, disabled: true } },
      environments: {
        select: {
          environment: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deleteApiToken(tokenId: string): Promise<boolean> {
  const result = await prisma.apiToken.deleteMany({ where: { id: tokenId } });
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
  await createUser(email, password, 'Admin', 'admin');
  console.log('Admin user created successfully');
}
