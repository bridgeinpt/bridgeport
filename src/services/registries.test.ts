import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    registryConnection: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc-data', nonce: 'nonce-1' }),
  decrypt: vi.fn().mockImplementation((ciphertext: string) => `decrypted-${ciphertext}`),
}));

import {
  createRegistryConnection,
  updateRegistryConnection,
  getRegistryConnection,
  listRegistryConnections,
  deleteRegistryConnection,
  getDefaultRegistryConnection,
  getRegistryCredentials,
} from './registries.js';
import { encrypt, decrypt } from '../lib/crypto.js';

describe('registries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRegistryRecord = {
    id: 'reg-1',
    name: 'my-registry',
    type: 'generic',
    registryUrl: 'https://registry.example.com',
    repositoryPrefix: null,
    encryptedToken: null,
    tokenNonce: null,
    username: null,
    encryptedPassword: null,
    passwordNonce: null,
    isDefault: false,
    refreshIntervalMinutes: 30,
    autoLinkPattern: null,
    lastRefreshAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    environmentId: 'env-1',
    _count: { containerImages: 0 },
  };

  describe('createRegistryConnection', () => {
    it('should create a registry with required fields', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue(baseRegistryRecord);

      const result = await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'generic',
        registryUrl: 'https://registry.example.com',
      });

      expect(result.id).toBe('reg-1');
      expect(result.name).toBe('my-registry');
      expect(result.type).toBe('generic');
      expect(result.hasToken).toBe(false);
      expect(result.hasPassword).toBe(false);
    });

    it('should encrypt token when provided', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedToken: 'enc-data',
        tokenNonce: 'nonce-1',
      });

      await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'digitalocean',
        registryUrl: 'https://registry.digitalocean.com',
        token: 'do-token-123',
      });

      expect(encrypt).toHaveBeenCalledWith('do-token-123');
      expect(mockPrisma.registryConnection.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          encryptedToken: 'enc-data',
          tokenNonce: 'nonce-1',
        }),
        include: { _count: { select: { containerImages: true } } },
      });
    });

    it('should encrypt password when provided', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedPassword: 'enc-data',
        passwordNonce: 'nonce-1',
      });

      await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'dockerhub',
        registryUrl: 'https://index.docker.io',
        username: 'user',
        password: 'pass123',
      });

      expect(encrypt).toHaveBeenCalledWith('pass123');
    });

    it('should unset other defaults when isDefault is true', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue({
        ...baseRegistryRecord,
        isDefault: true,
      });

      await createRegistryConnection('env-1', {
        name: 'default-registry',
        type: 'generic',
        registryUrl: 'https://registry.example.com',
        isDefault: true,
      });

      expect(mockPrisma.registryConnection.updateMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1', isDefault: true },
        data: { isDefault: false },
      });
    });

    it('should not unset defaults when isDefault is false', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue(baseRegistryRecord);

      await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'generic',
        registryUrl: 'https://registry.example.com',
        isDefault: false,
      });

      expect(mockPrisma.registryConnection.updateMany).not.toHaveBeenCalled();
    });

    it('should output hasToken and hasPassword correctly', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedToken: 'enc-token',
        encryptedPassword: 'enc-pass',
      });

      const result = await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'generic',
        registryUrl: 'https://registry.example.com',
        token: 'token',
        password: 'pass',
      });

      expect(result.hasToken).toBe(true);
      expect(result.hasPassword).toBe(true);
    });

    it('should use default refreshIntervalMinutes of 30', async () => {
      mockPrisma.registryConnection.create.mockResolvedValue(baseRegistryRecord);

      await createRegistryConnection('env-1', {
        name: 'my-registry',
        type: 'generic',
        registryUrl: 'https://registry.example.com',
      });

      expect(mockPrisma.registryConnection.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          refreshIntervalMinutes: 30,
        }),
        include: expect.any(Object),
      });
    });
  });

  describe('updateRegistryConnection', () => {
    it('should throw when registry not found', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(null);

      await expect(
        updateRegistryConnection('nonexistent', { name: 'new-name' })
      ).rejects.toThrow('Registry connection not found');
    });

    it('should update name', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);
      mockPrisma.registryConnection.update.mockResolvedValue({
        ...baseRegistryRecord,
        name: 'updated-name',
      });

      const result = await updateRegistryConnection('reg-1', { name: 'updated-name' });

      expect(result.name).toBe('updated-name');
    });

    it('should encrypt new token on update', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);
      mockPrisma.registryConnection.update.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedToken: 'enc-data',
        tokenNonce: 'nonce-1',
      });

      await updateRegistryConnection('reg-1', { token: 'new-token' });

      expect(encrypt).toHaveBeenCalledWith('new-token');
    });

    it('should clear token when set to empty string', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);
      mockPrisma.registryConnection.update.mockResolvedValue(baseRegistryRecord);

      await updateRegistryConnection('reg-1', { token: '' });

      expect(mockPrisma.registryConnection.update).toHaveBeenCalledWith({
        where: { id: 'reg-1' },
        data: expect.objectContaining({
          encryptedToken: null,
          tokenNonce: null,
        }),
        include: expect.any(Object),
      });
    });

    it('should clear password when set to empty string', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);
      mockPrisma.registryConnection.update.mockResolvedValue(baseRegistryRecord);

      await updateRegistryConnection('reg-1', { password: '' });

      expect(mockPrisma.registryConnection.update).toHaveBeenCalledWith({
        where: { id: 'reg-1' },
        data: expect.objectContaining({
          encryptedPassword: null,
          passwordNonce: null,
        }),
        include: expect.any(Object),
      });
    });

    it('should unset other defaults when setting isDefault', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);
      mockPrisma.registryConnection.update.mockResolvedValue({
        ...baseRegistryRecord,
        isDefault: true,
      });

      await updateRegistryConnection('reg-1', { isDefault: true });

      expect(mockPrisma.registryConnection.updateMany).toHaveBeenCalledWith({
        where: {
          environmentId: 'env-1',
          isDefault: true,
          id: { not: 'reg-1' },
        },
        data: { isDefault: false },
      });
    });
  });

  describe('getRegistryConnection', () => {
    it('should return formatted output for existing registry', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);

      const result = await getRegistryConnection('reg-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('reg-1');
      expect(result!.hasToken).toBe(false);
      expect(result!.hasPassword).toBe(false);
    });

    it('should return null for non-existent registry', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(null);

      const result = await getRegistryConnection('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('listRegistryConnections', () => {
    it('should return formatted list ordered by isDefault desc, name asc', async () => {
      mockPrisma.registryConnection.findMany.mockResolvedValue([
        { ...baseRegistryRecord, id: 'reg-2', name: 'b-registry' },
        { ...baseRegistryRecord, id: 'reg-1', name: 'a-registry', isDefault: true },
      ]);

      const result = await listRegistryConnections('env-1');

      expect(result).toHaveLength(2);
      expect(mockPrisma.registryConnection.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1' },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { containerImages: true } } },
      });
    });
  });

  describe('deleteRegistryConnection', () => {
    it('should delete a registry by ID', async () => {
      mockPrisma.registryConnection.delete.mockResolvedValue({});

      await deleteRegistryConnection('reg-1');

      expect(mockPrisma.registryConnection.delete).toHaveBeenCalledWith({
        where: { id: 'reg-1' },
      });
    });
  });

  describe('getDefaultRegistryConnection', () => {
    it('should return the default registry', async () => {
      mockPrisma.registryConnection.findFirst.mockResolvedValue({
        ...baseRegistryRecord,
        isDefault: true,
      });

      const result = await getDefaultRegistryConnection('env-1');

      expect(result).not.toBeNull();
      expect(result!.isDefault).toBe(true);
      expect(mockPrisma.registryConnection.findFirst).toHaveBeenCalledWith({
        where: { environmentId: 'env-1', isDefault: true },
        include: { _count: { select: { containerImages: true } } },
      });
    });

    it('should return null when no default exists', async () => {
      mockPrisma.registryConnection.findFirst.mockResolvedValue(null);

      const result = await getDefaultRegistryConnection('env-1');

      expect(result).toBeNull();
    });
  });

  describe('getRegistryCredentials', () => {
    it('should return null for non-existent registry', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(null);

      const result = await getRegistryCredentials('nonexistent');

      expect(result).toBeNull();
    });

    it('should return basic info without credentials', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue(baseRegistryRecord);

      const result = await getRegistryCredentials('reg-1');

      expect(result).toEqual({
        type: 'generic',
        registryUrl: 'https://registry.example.com',
        repositoryPrefix: null,
      });
    });

    it('should decrypt and include token when present', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedToken: 'enc-token',
        tokenNonce: 'token-nonce',
      });

      const result = await getRegistryCredentials('reg-1');

      expect(result!.token).toBeDefined();
      expect(decrypt).toHaveBeenCalledWith('enc-token', 'token-nonce');
    });

    it('should decrypt and include password when present', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue({
        ...baseRegistryRecord,
        username: 'user',
        encryptedPassword: 'enc-pass',
        passwordNonce: 'pass-nonce',
      });

      const result = await getRegistryCredentials('reg-1');

      expect(result!.username).toBe('user');
      expect(result!.password).toBeDefined();
      expect(decrypt).toHaveBeenCalledWith('enc-pass', 'pass-nonce');
    });

    it('should include all credentials when all present', async () => {
      mockPrisma.registryConnection.findUnique.mockResolvedValue({
        ...baseRegistryRecord,
        encryptedToken: 'enc-token',
        tokenNonce: 'token-nonce',
        username: 'user',
        encryptedPassword: 'enc-pass',
        passwordNonce: 'pass-nonce',
      });

      const result = await getRegistryCredentials('reg-1');

      expect(result!.token).toBeDefined();
      expect(result!.username).toBe('user');
      expect(result!.password).toBeDefined();
    });
  });
});
