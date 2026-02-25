/**
 * User factory for tests.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestUserOptions {
  email?: string;
  password?: string;
  name?: string;
  role?: 'admin' | 'operator' | 'viewer';
}

export async function createTestUser(
  prisma: PrismaClient,
  options: CreateTestUserOptions = {}
) {
  const n = nextId();
  const email = options.email ?? `user${n}@test.com`;
  const password = options.password ?? 'test-password-123';
  const passwordHash = await bcrypt.hash(password, 4); // Low rounds for speed

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: options.name ?? `Test User ${n}`,
      role: options.role ?? 'admin',
    },
  });

  return { ...user, password };
}

export function resetUserCounter() {
  counter = 0;
}
