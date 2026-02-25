import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    apiToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/crypto.js', () => ({
  generateToken: vi.fn().mockReturnValue('mock-token-value'),
  hashToken: vi.fn().mockReturnValue('hashed-token-value'),
}));

// Mock bcryptjs
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$12$hashedpassword'),
    compare: vi.fn(),
  },
}));

import bcrypt from 'bcryptjs';
import {
  createUser,
  validatePassword,
  getUserById,
  createApiToken,
  validateApiToken,
  listApiTokens,
  deleteApiToken,
  bootstrapAdminUser,
} from './auth.js';

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createUser', () => {
    it('creates a user with hashed password', async () => {
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        role: 'admin',
      });

      const user = await createUser('test@example.com', 'password123', 'Test User', 'admin');

      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.role).toBe('admin');
      expect(user.id).toBe('user-1');
      expect(bcrypt.hash).toHaveBeenCalledWith('password123', 12);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'test@example.com',
          passwordHash: '$2a$12$hashedpassword',
          name: 'Test User',
          role: 'admin',
        },
        select: { id: true, email: true, name: true, role: true },
      });
    });

    it('defaults role to viewer', async () => {
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'viewer@example.com',
        name: undefined,
        role: 'viewer',
      });

      const user = await createUser('viewer@example.com', 'pass');
      expect(user.role).toBe('viewer');
    });

    it('rejects duplicate emails', async () => {
      mockPrisma.user.create.mockRejectedValue(new Error('Unique constraint failed'));

      await expect(createUser('dupe@example.com', 'pass')).rejects.toThrow();
    });
  });

  describe('validatePassword', () => {
    it('returns user for valid credentials', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'valid@example.com',
        name: 'Valid User',
        role: 'admin',
        passwordHash: '$2a$12$hashed',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      const user = await validatePassword('valid@example.com', 'correct-password');

      expect(user).not.toBeNull();
      expect(user!.email).toBe('valid@example.com');
      expect(user!.role).toBe('admin');
    });

    it('returns null for wrong password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: '$2a$12$hashed',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const user = await validatePassword('user@example.com', 'wrong-password');
      expect(user).toBeNull();
    });

    it('returns null for non-existent email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const user = await validatePassword('nobody@example.com', 'any-password');
      expect(user).toBeNull();
    });
  });

  describe('getUserById', () => {
    it('returns user by ID', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'find@example.com',
        name: 'Find Me',
        role: 'viewer',
      });

      const user = await getUserById('user-1');

      expect(user).not.toBeNull();
      expect(user!.email).toBe('find@example.com');
      expect(user!.name).toBe('Find Me');
    });

    it('returns null for non-existent ID', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const user = await getUserById('nonexistent-id');
      expect(user).toBeNull();
    });
  });

  describe('API tokens', () => {
    describe('createApiToken', () => {
      it('creates a token and returns raw token + record', async () => {
        const tokenRecord = {
          id: 'tok-1',
          name: 'My Token',
          tokenHash: 'hashed',
          userId: 'user-1',
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
        };
        mockPrisma.apiToken.create.mockResolvedValue(tokenRecord);

        const result = await createApiToken('user-1', 'My Token');

        expect(result.token).toBe('mock-token-value');
        expect(result.tokenRecord.name).toBe('My Token');
        expect(result.tokenRecord.userId).toBe('user-1');
      });

      it('creates token with expiry date', async () => {
        const expiresAt = new Date(Date.now() + 86400000);
        mockPrisma.apiToken.create.mockResolvedValue({
          id: 'tok-1',
          name: 'Expiring Token',
          expiresAt,
          userId: 'user-1',
        });

        const { tokenRecord } = await createApiToken('user-1', 'Expiring Token', expiresAt);
        expect(tokenRecord.expiresAt).toBeDefined();
      });
    });

    describe('validateApiToken', () => {
      it('validates a valid token', async () => {
        mockPrisma.apiToken.findUnique.mockResolvedValue({
          id: 'tok-1',
          tokenHash: 'hashed',
          expiresAt: null,
          user: { id: 'user-1', email: 'user@example.com', name: 'User', role: 'operator' },
        });
        mockPrisma.apiToken.update.mockResolvedValue({});

        const user = await validateApiToken('mock-token');

        expect(user).not.toBeNull();
        expect(user!.id).toBe('user-1');
        expect(user!.role).toBe('operator');
      });

      it('returns null for invalid token', async () => {
        mockPrisma.apiToken.findUnique.mockResolvedValue(null);

        const user = await validateApiToken('invalid-token-value');
        expect(user).toBeNull();
      });

      it('returns null for expired token', async () => {
        mockPrisma.apiToken.findUnique.mockResolvedValue({
          id: 'tok-1',
          expiresAt: new Date(Date.now() - 1000), // Already expired
          user: { id: 'user-1', email: 'user@example.com', name: 'User', role: 'operator' },
        });

        const user = await validateApiToken('expired-token');
        expect(user).toBeNull();
      });

      it('updates lastUsedAt on validation', async () => {
        mockPrisma.apiToken.findUnique.mockResolvedValue({
          id: 'tok-1',
          expiresAt: null,
          user: { id: 'user-1', email: 'user@example.com', name: 'User', role: 'operator' },
        });
        mockPrisma.apiToken.update.mockResolvedValue({});

        await validateApiToken('valid-token');

        expect(mockPrisma.apiToken.update).toHaveBeenCalledWith({
          where: { id: 'tok-1' },
          data: { lastUsedAt: expect.any(Date) },
        });
      });
    });

    describe('listApiTokens', () => {
      it('lists tokens for a user', async () => {
        mockPrisma.apiToken.findMany.mockResolvedValue([
          { id: 'tok-1', name: 'Token 1', userId: 'user-1' },
          { id: 'tok-2', name: 'Token 2', userId: 'user-1' },
        ]);

        const tokens = await listApiTokens('user-1');

        expect(tokens).toHaveLength(2);
        expect(tokens[0]).not.toHaveProperty('tokenHash');
      });

      it('returns empty array for user with no tokens', async () => {
        mockPrisma.apiToken.findMany.mockResolvedValue([]);

        const tokens = await listApiTokens('user-1');
        expect(tokens).toEqual([]);
      });
    });

    describe('deleteApiToken', () => {
      it('deletes a token belonging to the user', async () => {
        mockPrisma.apiToken.deleteMany.mockResolvedValue({ count: 1 });

        const deleted = await deleteApiToken('tok-1', 'user-1');
        expect(deleted).toBe(true);
      });

      it('returns false for non-existent token', async () => {
        mockPrisma.apiToken.deleteMany.mockResolvedValue({ count: 0 });

        const deleted = await deleteApiToken('nonexistent', 'user-1');
        expect(deleted).toBe(false);
      });

      it('returns false when userId does not match', async () => {
        mockPrisma.apiToken.deleteMany.mockResolvedValue({ count: 0 });

        const deleted = await deleteApiToken('tok-1', 'wrong-user');
        expect(deleted).toBe(false);
      });
    });
  });

  describe('bootstrapAdminUser', () => {
    it('creates admin user when no users exist', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin',
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapAdminUser('admin@example.com', 'admin-pass');
      consoleSpy.mockRestore();

      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('does not create user when users already exist', async () => {
      mockPrisma.user.count.mockResolvedValue(1);

      await bootstrapAdminUser('admin@example.com', 'admin-pass');

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('does nothing when email is undefined', async () => {
      await bootstrapAdminUser(undefined, 'pass');

      expect(mockPrisma.user.count).not.toHaveBeenCalled();
    });

    it('does nothing when password is undefined', async () => {
      await bootstrapAdminUser('admin@example.com', undefined);

      expect(mockPrisma.user.count).not.toHaveBeenCalled();
    });
  });
});
