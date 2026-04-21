import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    secret: {
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    var: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc-data', nonce: 'nonce-1' }),
  decrypt: vi.fn().mockImplementation((ciphertext: string, _nonce: string) => `decrypted-${ciphertext}`),
}));

import {
  createSecret,
  updateSecret,
  getSecretValue,
  listSecrets,
  deleteSecret,
  getSecretsForEnv,
  resolveSecretPlaceholders,
} from './secrets.js';
import { encrypt, decrypt } from '../lib/crypto.js';

describe('secrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSecret', () => {
    it('creates an encrypted secret', async () => {
      mockPrisma.secret.create.mockResolvedValue({
        id: 'sec-1',
        key: 'DB_PASSWORD',
        description: 'Database password',
        neverReveal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await createSecret('env-1', {
        key: 'DB_PASSWORD',
        value: 'super-secret-value',
        description: 'Database password',
      });

      expect(result.key).toBe('DB_PASSWORD');
      expect(result.description).toBe('Database password');
      expect(result.neverReveal).toBe(false);
      expect(encrypt).toHaveBeenCalledWith('super-secret-value');
      expect(mockPrisma.secret.create).toHaveBeenCalledWith({
        data: {
          key: 'DB_PASSWORD',
          encryptedValue: 'enc-data',
          nonce: 'nonce-1',
          description: 'Database password',
          neverReveal: false,
          environmentId: 'env-1',
        },
        select: {
          id: true,
          key: true,
          description: true,
          neverReveal: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('creates secret with neverReveal flag', async () => {
      mockPrisma.secret.create.mockResolvedValue({
        id: 'sec-1',
        key: 'API_KEY',
        description: null,
        neverReveal: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await createSecret('env-1', {
        key: 'API_KEY',
        value: 'key-value',
        neverReveal: true,
      });

      expect(result.neverReveal).toBe(true);
    });

    it('does not return raw value in output', async () => {
      mockPrisma.secret.create.mockResolvedValue({
        id: 'sec-1',
        key: 'SECRET',
        description: null,
        neverReveal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await createSecret('env-1', {
        key: 'SECRET',
        value: 'hidden',
      });

      expect(result).not.toHaveProperty('value');
      expect(result).not.toHaveProperty('encryptedValue');
    });
  });

  describe('updateSecret', () => {
    it('updates secret value', async () => {
      mockPrisma.secret.update.mockResolvedValue({
        id: 'sec-1',
        key: 'KEY',
        description: null,
        neverReveal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await updateSecret('sec-1', { value: 'new-value' });

      expect(encrypt).toHaveBeenCalledWith('new-value');
      expect(mockPrisma.secret.update).toHaveBeenCalledWith({
        where: { id: 'sec-1' },
        data: {
          encryptedValue: 'enc-data',
          nonce: 'nonce-1',
        },
        select: expect.any(Object),
      });
    });

    it('updates description without changing value', async () => {
      mockPrisma.secret.update.mockResolvedValue({
        id: 'sec-1',
        key: 'KEY',
        description: 'new desc',
        neverReveal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await updateSecret('sec-1', { description: 'new desc' });

      expect(encrypt).not.toHaveBeenCalled();
      expect(mockPrisma.secret.update).toHaveBeenCalledWith({
        where: { id: 'sec-1' },
        data: { description: 'new desc' },
        select: expect.any(Object),
      });
    });

    it('updates neverReveal flag', async () => {
      mockPrisma.secret.update.mockResolvedValue({
        id: 'sec-1',
        key: 'KEY',
        description: null,
        neverReveal: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await updateSecret('sec-1', { neverReveal: true });
      expect(updated.neverReveal).toBe(true);
    });
  });

  describe('getSecretValue', () => {
    it('decrypts and returns the secret value', async () => {
      mockPrisma.secret.findUniqueOrThrow.mockResolvedValue({
        encryptedValue: 'encrypted-val',
        nonce: 'nonce-val',
      });

      const value = await getSecretValue('sec-1');

      expect(decrypt).toHaveBeenCalledWith('encrypted-val', 'nonce-val');
      expect(value).toBe('decrypted-encrypted-val');
    });

    it('throws for non-existent secret', async () => {
      mockPrisma.secret.findUniqueOrThrow.mockRejectedValue(new Error('Not found'));

      await expect(getSecretValue('nonexistent')).rejects.toThrow();
    });
  });

  describe('listSecrets', () => {
    it('lists secrets for an environment ordered by key', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([
        { id: '1', key: 'A_KEY', description: null, neverReveal: false, createdAt: new Date(), updatedAt: new Date() },
        { id: '2', key: 'Z_KEY', description: null, neverReveal: false, createdAt: new Date(), updatedAt: new Date() },
      ]);

      const secrets = await listSecrets('env-1');

      expect(secrets).toHaveLength(2);
      expect(secrets[0].key).toBe('A_KEY');
      expect(secrets[1].key).toBe('Z_KEY');
      expect(mockPrisma.secret.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1' },
        select: {
          id: true,
          key: true,
          description: true,
          neverReveal: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { key: 'asc' },
      });
    });

    it('returns empty array for environment with no secrets', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([]);

      const secrets = await listSecrets('env-1');
      expect(secrets).toEqual([]);
    });
  });

  describe('deleteSecret', () => {
    it('deletes a secret', async () => {
      mockPrisma.secret.delete.mockResolvedValue({});

      await deleteSecret('sec-1');

      expect(mockPrisma.secret.delete).toHaveBeenCalledWith({
        where: { id: 'sec-1' },
      });
    });
  });

  describe('getSecretsForEnv', () => {
    it('returns all secrets as key-value map', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([
        { key: 'DB_HOST', encryptedValue: 'enc-host', nonce: 'n1' },
        { key: 'DB_PORT', encryptedValue: 'enc-port', nonce: 'n2' },
      ]);

      vi.mocked(decrypt)
        .mockReturnValueOnce('localhost')
        .mockReturnValueOnce('5432');

      const secrets = await getSecretsForEnv('env-1');

      expect(secrets).toEqual({
        DB_HOST: 'localhost',
        DB_PORT: '5432',
      });
    });

    it('returns empty object for environment with no secrets', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([]);

      const secrets = await getSecretsForEnv('env-1');
      expect(secrets).toEqual({});
    });
  });

  describe('resolveSecretPlaceholders', () => {
    it('resolves ${KEY} placeholders in content', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([
        { key: 'DB_HOST', encryptedValue: 'enc1', nonce: 'n1' },
        { key: 'DB_PORT', encryptedValue: 'enc2', nonce: 'n2' },
      ]);
      vi.mocked(decrypt)
        .mockReturnValueOnce('db.example.com')
        .mockReturnValueOnce('5432');

      const { content, missing } = await resolveSecretPlaceholders(
        'env-1',
        'host=${DB_HOST} port=${DB_PORT}'
      );

      expect(content).toBe('host=db.example.com port=5432');
      expect(missing).toEqual([]);
    });

    it('reports missing placeholders', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([
        { key: 'DB_HOST', encryptedValue: 'enc1', nonce: 'n1' },
      ]);
      vi.mocked(decrypt).mockReturnValue('localhost');

      const { content, missing } = await resolveSecretPlaceholders(
        'env-1',
        'host=${DB_HOST} password=${DB_PASSWORD}'
      );

      expect(content).toBe('host=localhost password=${DB_PASSWORD}');
      expect(missing).toEqual(['DB_PASSWORD']);
    });

    it('handles content with no placeholders', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([]);

      const { content, missing } = await resolveSecretPlaceholders('env-1', 'no placeholders here');
      expect(content).toBe('no placeholders here');
      expect(missing).toEqual([]);
    });

    it('deduplicates missing keys', async () => {
      mockPrisma.secret.findMany.mockResolvedValue([]);

      const { missing } = await resolveSecretPlaceholders(
        'env-1',
        '${MISSING} and ${MISSING} again'
      );

      expect(missing).toEqual(['MISSING']);
    });
  });
});
