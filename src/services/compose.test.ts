import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findUniqueOrThrow: vi.fn() },
    deployment: { findUnique: vi.fn() },
    deploymentArtifact: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    configFile: { findMany: vi.fn() },
    secret: { findMany: vi.fn() },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted-value'),
}));

vi.mock('./secrets.js', () => ({
  resolveSecretPlaceholders: vi.fn().mockResolvedValue({ content: 'resolved', unresolvedKeys: [] }),
}));

import { prisma } from '../lib/db.js';
import {
  generateDeploymentArtifacts,
  saveDeploymentArtifacts,
  getDeploymentArtifacts,
} from './compose.js';

const mockPrisma = vi.mocked(prisma);

describe('compose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateDeploymentArtifacts', () => {
    it('generates compose file with service variables', async () => {
      const service = {
        id: 'svc-1',
        name: 'web-app',
        containerName: 'web-app',
        imageName: 'registry.com/web-app',
        imageTag: 'v1.0',
        composeTemplate: null,
        server: {
          id: 'srv-1',
          hostname: 'prod.local',
          name: 'prod-server',
          environmentId: 'env-1',
          environment: { id: 'env-1', name: 'Production' },
        },
        environment: { id: 'env-1', name: 'Production' },
        containerImage: { id: 'img-1', imageName: 'registry.com/web-app', tagFilter: 'v1.0' },
        files: [],
      };

      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);

      // generateDeploymentArtifacts only takes serviceId
      const artifacts = await generateDeploymentArtifacts('svc-1');

      expect(artifacts).toBeDefined();
      expect(artifacts.compose).toBeDefined();
      expect(artifacts.compose.content).toBeDefined();
      expect(artifacts.compose.name).toContain('web-app');
    });
  });

  describe('saveDeploymentArtifacts', () => {
    it('saves artifacts for a deployment', async () => {
      mockPrisma.deploymentArtifact.createMany.mockResolvedValue({ count: 1 });

      await saveDeploymentArtifacts('dep-1', {
        compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'abc123' },
        configFiles: [],
      });

      expect(mockPrisma.deploymentArtifact.createMany).toHaveBeenCalled();
    });
  });

  describe('getDeploymentArtifacts', () => {
    it('returns artifacts for a deployment', async () => {
      mockPrisma.deploymentArtifact.findMany.mockResolvedValue([
        { id: 'art-1', type: 'compose', content: 'services:' },
      ] as any);

      const artifacts = await getDeploymentArtifacts('dep-1');
      expect(artifacts).toHaveLength(1);
    });

    it('returns empty array when no artifacts exist', async () => {
      mockPrisma.deploymentArtifact.findMany.mockResolvedValue([]);

      const artifacts = await getDeploymentArtifacts('dep-1');
      expect(artifacts).toEqual([]);
    });
  });
});
