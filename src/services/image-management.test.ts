import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    containerImage: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    containerImageHistory: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    service: {
      count: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    imageDigest: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/registry.js', () => ({
  RegistryFactory: { create: vi.fn() },
}));

vi.mock('../lib/image-utils.js', () => ({
  parseTagFilter: vi.fn().mockReturnValue(['latest']),
  matchesTagFilter: vi.fn().mockReturnValue(true),
  getBestTag: vi.fn().mockReturnValue('latest'),
  getDefaultTag: vi.fn().mockReturnValue('latest'),
  extractRepoName: vi.fn().mockReturnValue('test/repo'),
}));

vi.mock('./registries.js', () => ({
  getRegistryCredentials: vi.fn(),
}));

import {
  createContainerImage,
  updateContainerImage,
  deleteContainerImage,
  linkServiceToContainerImage,
  recordTagDeployment,
  getPreviousTag,
  findOrCreateContainerImage,
  syncDigestsFromRegistry,
} from './image-management.js';

import { matchesTagFilter } from '../lib/image-utils.js';

describe('image-management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createContainerImage', () => {
    it('creates image with tagFilter', async () => {
      mockPrisma.containerImage.create.mockResolvedValue({
        id: 'img-1',
        name: 'Test',
        imageName: 'registry.com/app',
        tagFilter: 'v1.0',
      });

      const image = await createContainerImage({
        name: 'Test',
        imageName: 'registry.com/app',
        tagFilter: 'v1.0',
        environmentId: 'env-1',
      });

      expect(image.tagFilter).toBe('v1.0');
      expect(mockPrisma.containerImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tagFilter: 'v1.0' }),
      });
    });
  });

  describe('updateContainerImage', () => {
    it('updates tagFilter', async () => {
      mockPrisma.containerImage.update.mockResolvedValue({
        id: 'img-1',
        tagFilter: 'v2.*',
      });

      const updated = await updateContainerImage('img-1', { tagFilter: 'v2.*' });
      expect(updated.tagFilter).toBe('v2.*');
    });
  });

  describe('deleteContainerImage', () => {
    it('throws if services linked', async () => {
      mockPrisma.service.count.mockResolvedValue(2);
      await expect(deleteContainerImage('img-1')).rejects.toThrow(/Cannot delete/);
    });

    it('deletes if no services linked', async () => {
      mockPrisma.service.count.mockResolvedValue(0);
      mockPrisma.containerImage.delete.mockResolvedValue({});
      await deleteContainerImage('img-1');
      expect(mockPrisma.containerImage.delete).toHaveBeenCalledWith({ where: { id: 'img-1' } });
    });
  });

  describe('linkServiceToContainerImage', () => {
    it('links service and sets imageDigestId from latest digest', async () => {
      mockPrisma.containerImage.findUniqueOrThrow.mockResolvedValue({
        id: 'img-1',
        tagFilter: 'latest',
      });
      mockPrisma.imageDigest.findFirst.mockResolvedValue({
        id: 'digest-1',
        tags: '["latest", "v1.0"]',
      });
      mockPrisma.service.update.mockResolvedValue({ id: 'svc-1', imageDigestId: 'digest-1' });

      const result = await linkServiceToContainerImage('img-1', 'svc-1');
      expect(result.imageDigestId).toBe('digest-1');
      expect(mockPrisma.service.update).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: expect.objectContaining({
          containerImageId: 'img-1',
          imageDigestId: 'digest-1',
        }),
      });
    });
  });

  describe('recordTagDeployment', () => {
    it('creates history and clears updateAvailable on success', async () => {
      mockPrisma.containerImage.update.mockResolvedValue({});
      mockPrisma.service.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.containerImageHistory.create.mockResolvedValue({
        id: 'hist-1',
        tag: 'v2.0',
        status: 'success',
      });

      const entry = await recordTagDeployment('img-1', 'v2.0', 'sha256:abc', 'user@test.com', 'success', 'digest-1');
      expect(entry.status).toBe('success');
      expect(mockPrisma.containerImage.update).toHaveBeenCalledWith({
        where: { id: 'img-1' },
        data: { updateAvailable: false },
      });
      expect(mockPrisma.service.updateMany).toHaveBeenCalledWith({
        where: { containerImageId: 'img-1' },
        data: { imageDigestId: 'digest-1' },
      });
    });

    it('does not update services on failure', async () => {
      mockPrisma.containerImageHistory.create.mockResolvedValue({
        id: 'hist-2',
        tag: 'v2.0',
        status: 'failed',
      });

      await recordTagDeployment('img-1', 'v2.0', undefined, 'user@test.com', 'failed');
      expect(mockPrisma.containerImage.update).not.toHaveBeenCalled();
      expect(mockPrisma.service.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getPreviousTag', () => {
    it('returns second most recent successful tag', async () => {
      mockPrisma.containerImageHistory.findMany.mockResolvedValue([
        { tag: 'v2.0', status: 'success' },
        { tag: 'v1.0', status: 'success' },
      ]);

      const prev = await getPreviousTag('img-1');
      expect(prev).toBe('v1.0');
    });

    it('returns null if only one deployment', async () => {
      mockPrisma.containerImageHistory.findMany.mockResolvedValue([
        { tag: 'v1.0', status: 'success' },
      ]);

      const prev = await getPreviousTag('img-1');
      expect(prev).toBeNull();
    });
  });

  describe('findOrCreateContainerImage', () => {
    it('creates new image with tagFilter if not found', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue(null);
      mockPrisma.containerImage.create.mockResolvedValue({
        id: 'img-new',
        imageName: 'registry.com/new-app',
        tagFilter: 'v1.0',
      });

      const image = await findOrCreateContainerImage('env-1', 'registry.com/new-app', 'v1.0');
      expect(image.imageName).toBe('registry.com/new-app');
      expect(mockPrisma.containerImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tagFilter: 'v1.0' }),
      });
    });

    it('returns existing if found', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({
        id: 'img-1',
        imageName: 'registry.com/app',
        tagFilter: 'v1.0',
      });

      const found = await findOrCreateContainerImage('env-1', 'registry.com/app', 'v2.0');
      expect(found.id).toBe('img-1');
      expect(found.tagFilter).toBe('v1.0');
    });
  });

  describe('syncDigestsFromRegistry', () => {
    it('creates new digests and sets updateAvailable', async () => {
      mockPrisma.containerImage.findUniqueOrThrow.mockResolvedValue({
        id: 'img-1',
        tagFilter: 'latest',
        services: [{ imageDigestId: null }],
      });

      vi.mocked(matchesTagFilter).mockReturnValue(true);

      mockPrisma.imageDigest.findUnique.mockResolvedValue(null);
      mockPrisma.imageDigest.create.mockResolvedValue({ id: 'new-digest' });
      mockPrisma.imageDigest.findFirst.mockResolvedValue({ id: 'new-digest' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      const result = await syncDigestsFromRegistry('img-1', [
        { tag: 'latest', digest: 'sha256:abc123', size: 100, updatedAt: '2025-01-01T00:00:00Z' },
      ]);

      expect(result.newDigests).toBe(1);
      expect(result.hasUpdate).toBe(true);
      expect(mockPrisma.imageDigest.create).toHaveBeenCalled();
    });

    it('updates tags on existing digest', async () => {
      mockPrisma.containerImage.findUniqueOrThrow.mockResolvedValue({
        id: 'img-1',
        tagFilter: 'latest',
        services: [{ imageDigestId: 'existing-digest' }],
      });

      vi.mocked(matchesTagFilter).mockReturnValue(true);

      mockPrisma.imageDigest.findUnique.mockResolvedValue({
        id: 'existing-digest',
        tags: '["latest"]',
      });
      mockPrisma.imageDigest.update.mockResolvedValue({});
      mockPrisma.imageDigest.findFirst.mockResolvedValue({ id: 'existing-digest' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      const result = await syncDigestsFromRegistry('img-1', [
        { tag: 'latest', digest: 'sha256:abc123', size: 100, updatedAt: '2025-01-01T00:00:00Z' },
        { tag: 'v1.0', digest: 'sha256:abc123', size: 100, updatedAt: '2025-01-01T00:00:00Z' },
      ]);

      expect(result.updatedDigests).toBe(1);
      expect(mockPrisma.imageDigest.update).toHaveBeenCalledWith({
        where: { id: 'existing-digest' },
        data: { tags: JSON.stringify(['latest', 'v1.0']) },
      });
    });

    it('skips tags not matching filter', async () => {
      mockPrisma.containerImage.findUniqueOrThrow.mockResolvedValue({
        id: 'img-1',
        tagFilter: 'v*',
        services: [],
      });

      vi.mocked(matchesTagFilter).mockReturnValue(false);

      mockPrisma.imageDigest.findFirst.mockResolvedValue(null);
      mockPrisma.containerImage.update.mockResolvedValue({});

      const result = await syncDigestsFromRegistry('img-1', [
        { tag: 'nightly', digest: 'sha256:xyz', size: 100, updatedAt: '2025-01-01T00:00:00Z' },
      ]);

      expect(result.newDigests).toBe(0);
      expect(mockPrisma.imageDigest.create).not.toHaveBeenCalled();
    });
  });
});
