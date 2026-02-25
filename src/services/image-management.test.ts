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
    },
    service: {
      count: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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
  findLatestInFamily: vi.fn().mockReturnValue({ latestTag: null, currentDigest: null }),
  findCompanionTag: vi.fn().mockReturnValue(null),
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
  detectUpdate,
} from './image-management.js';

import { findLatestInFamily, findCompanionTag } from '../lib/image-utils.js';

describe('image-management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createContainerImage', () => {
    it('creates a container image', async () => {
      mockPrisma.containerImage.create.mockResolvedValue({
        id: 'img-1',
        name: 'web-app',
        imageName: 'registry.example.com/web-app',
        currentTag: 'v1.0',
        environmentId: 'env-1',
      });

      const image = await createContainerImage({
        name: 'web-app',
        imageName: 'registry.example.com/web-app',
        currentTag: 'v1.0',
        environmentId: 'env-1',
      });

      expect(image.name).toBe('web-app');
      expect(image.imageName).toBe('registry.example.com/web-app');
      expect(image.currentTag).toBe('v1.0');
    });
  });

  describe('updateContainerImage', () => {
    it('updates specified fields', async () => {
      mockPrisma.containerImage.update.mockResolvedValue({
        id: 'img-1',
        currentTag: 'v2.0',
        autoUpdate: true,
      });

      const updated = await updateContainerImage('img-1', {
        currentTag: 'v2.0',
        autoUpdate: true,
      });

      expect(updated.currentTag).toBe('v2.0');
      expect(updated.autoUpdate).toBe(true);
    });
  });

  describe('deleteContainerImage', () => {
    it('deletes an image with no linked services', async () => {
      mockPrisma.service.count.mockResolvedValue(0);
      mockPrisma.containerImage.delete.mockResolvedValue({});

      await deleteContainerImage('img-1');

      expect(mockPrisma.containerImage.delete).toHaveBeenCalledWith({
        where: { id: 'img-1' },
      });
    });

    it('throws when services are linked', async () => {
      mockPrisma.service.count.mockResolvedValue(1);

      await expect(deleteContainerImage('img-1')).rejects.toThrow(
        /Cannot delete container image: 1 service\(s\)/
      );
    });
  });

  describe('recordTagDeployment', () => {
    it('creates history record and updates current tag on success', async () => {
      const mockImage = {
        id: 'img-1',
        currentTag: 'v1.0',
        latestTag: null,
        latestDigest: null,
      };
      mockPrisma.containerImage.findUnique.mockResolvedValue(mockImage);
      mockPrisma.containerImageHistory.create.mockResolvedValue({
        id: 'hist-1',
        tag: 'v2.0',
        status: 'success',
      });
      mockPrisma.containerImage.update.mockResolvedValue({});

      const history = await recordTagDeployment('img-1', 'v2.0', undefined, 'user-1', 'success');

      expect(history.tag).toBe('v2.0');
      expect(history.status).toBe('success');
      expect(mockPrisma.containerImage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currentTag: 'v2.0',
            updateAvailable: false,
          }),
        })
      );
    });

    it('does not update current tag on failure', async () => {
      const mockImage = {
        id: 'img-1',
        currentTag: 'v1.0',
        latestTag: null,
        latestDigest: null,
      };
      mockPrisma.containerImage.findUnique.mockResolvedValue(mockImage);
      mockPrisma.containerImageHistory.create.mockResolvedValue({
        id: 'hist-1',
        tag: 'v2.0',
        status: 'failed',
      });

      await recordTagDeployment('img-1', 'v2.0', undefined, 'user-1', 'failed');

      // Should NOT update current tag on failure
      expect(mockPrisma.containerImage.update).not.toHaveBeenCalled();
    });

    it('resolves digest from latestDigest when deploying latest tag', async () => {
      const mockImage = {
        id: 'img-1',
        currentTag: 'v1.0',
        latestTag: 'v2.0',
        latestDigest: 'sha256:abc123',
      };
      mockPrisma.containerImage.findUnique.mockResolvedValue(mockImage);
      mockPrisma.containerImageHistory.create.mockResolvedValue({
        id: 'hist-1',
        tag: 'v2.0',
        status: 'success',
      });
      mockPrisma.containerImage.update.mockResolvedValue({});

      await recordTagDeployment('img-1', 'v2.0', undefined, 'user-1', 'success');

      expect(mockPrisma.containerImage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deployedDigest: 'sha256:abc123',
          }),
        })
      );
    });
  });

  describe('getPreviousTag', () => {
    it('returns second most recent successful tag', async () => {
      mockPrisma.containerImageHistory.findMany.mockResolvedValue([
        { tag: 'v2.0', status: 'success', createdAt: new Date() },
        { tag: 'v1.0', status: 'success', createdAt: new Date() },
      ]);

      const prev = await getPreviousTag('img-1');
      expect(prev).toBe('v1.0');
    });

    it('returns null when only one successful deployment', async () => {
      mockPrisma.containerImageHistory.findMany.mockResolvedValue([
        { tag: 'v1.0', status: 'success', createdAt: new Date() },
      ]);

      const prev = await getPreviousTag('img-1');
      expect(prev).toBeNull();
    });

    it('ignores failed deployments', async () => {
      mockPrisma.containerImageHistory.findMany.mockResolvedValue([
        { tag: 'v1.0', status: 'success', createdAt: new Date() },
      ]);

      const prev = await getPreviousTag('img-1');
      expect(prev).toBeNull();
    });
  });

  describe('findOrCreateContainerImage', () => {
    it('creates new image if not found', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue(null);
      mockPrisma.containerImage.create.mockResolvedValue({
        id: 'img-new',
        imageName: 'registry.com/new-app',
        name: 'new-app',
        currentTag: 'v1.0',
      });

      const image = await findOrCreateContainerImage('env-1', 'registry.com/new-app', 'v1.0');

      expect(image.imageName).toBe('registry.com/new-app');
    });

    it('returns existing image if found', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({
        id: 'img-1',
        imageName: 'registry.com/app',
        currentTag: 'v1.0',
      });

      const found = await findOrCreateContainerImage('env-1', 'registry.com/app', 'v2.0');
      expect(found.id).toBe('img-1');
      expect(found.currentTag).toBe('v1.0');
    });
  });

  describe('detectUpdate', () => {
    it('detects version tag update', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({ id: 'img-1' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      vi.mocked(findLatestInFamily).mockReturnValue({
        latestTag: { tag: 'v2.0', digest: 'sha256:new', lastUpdated: new Date() },
        currentDigest: 'sha256:old',
      });

      const result = await detectUpdate('img-1', 'v1.0', null, []);

      expect(result.hasUpdate).toBe(true);
      expect(result.latestTag).toBe('v2.0');
    });

    it('detects rolling tag update via digest comparison', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({ id: 'img-1' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      vi.mocked(findLatestInFamily).mockReturnValue({
        latestTag: { tag: 'latest', digest: 'sha256:new-digest', lastUpdated: new Date() },
        currentDigest: null,
      });

      const result = await detectUpdate('img-1', 'latest', 'sha256:old-digest', []);
      expect(result.hasUpdate).toBe(true);
    });

    it('no update when digest matches', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({ id: 'img-1' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      vi.mocked(findLatestInFamily).mockReturnValue({
        latestTag: { tag: 'latest', digest: 'sha256:same', lastUpdated: new Date() },
        currentDigest: null,
      });

      const result = await detectUpdate('img-1', 'latest', 'sha256:same', []);
      expect(result.hasUpdate).toBe(false);
    });

    it('returns no update when no latest tag found', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({ id: 'img-1' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      vi.mocked(findLatestInFamily).mockReturnValue({
        latestTag: null,
        currentDigest: null,
      });

      const result = await detectUpdate('img-1', 'v1.0', null, []);
      expect(result.hasUpdate).toBe(false);
      expect(result.latestTag).toBeNull();
    });

    it('uses companion tag for rolling tags', async () => {
      mockPrisma.containerImage.findUnique.mockResolvedValue({ id: 'img-1' });
      mockPrisma.containerImage.update.mockResolvedValue({});

      vi.mocked(findLatestInFamily).mockReturnValue({
        latestTag: { tag: 'latest', digest: 'sha256:new', lastUpdated: new Date() },
        currentDigest: null,
      });
      vi.mocked(findCompanionTag).mockReturnValue('20260224-abc1234');

      const result = await detectUpdate('img-1', 'latest', 'sha256:old', []);
      expect(result.latestTag).toBe('20260224-abc1234');
    });
  });

  describe('linkServiceToContainerImage', () => {
    it('links service and syncs image tag', async () => {
      mockPrisma.containerImage.findUniqueOrThrow.mockResolvedValue({
        id: 'img-1',
        imageName: 'test/app',
        currentTag: 'v2.0',
      });
      mockPrisma.service.update.mockResolvedValue({
        id: 'svc-1',
        containerImageId: 'img-1',
        imageTag: 'v2.0',
      });

      const updated = await linkServiceToContainerImage('img-1', 'svc-1');

      expect(updated.containerImageId).toBe('img-1');
      expect(updated.imageTag).toBe('v2.0');
    });
  });
});
