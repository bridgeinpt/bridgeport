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

import YAML from 'yaml';
import { prisma } from '../lib/db.js';
import {
  generateDeploymentArtifacts,
  saveDeploymentArtifacts,
  getDeploymentArtifacts,
  serializeExposedPorts,
} from './compose.js';

const mockPrisma = vi.mocked(prisma);

function baseService(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-1',
    name: 'web-app',
    containerName: 'web-app',
    imageName: 'registry.com/web-app',
    imageTag: 'v1.0',
    composeTemplate: null,
    exposedPorts: null,
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
    ...overrides,
  };
}

describe('compose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateDeploymentArtifacts', () => {
    it('generates compose file with service variables', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService() as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');

      expect(artifacts).toBeDefined();
      expect(artifacts.compose).toBeDefined();
      expect(artifacts.compose.content).toBeDefined();
      expect(artifacts.compose.name).toContain('web-app');
    });

    it('includes ports section from discovered exposedPorts', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService({
        exposedPorts: JSON.stringify([
          { host: 8080, container: 80, protocol: 'tcp' },
        ]),
      }) as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');
      const parsed = YAML.parse(artifacts.compose.content);

      expect(parsed.services['web-app'].ports).toEqual(['8080:80']);
    });

    it('defaults host port to container port when host is null (issue #117)', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService({
        exposedPorts: JSON.stringify([
          { host: null, container: 80, protocol: 'tcp' },
        ]),
      }) as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');
      const parsed = YAML.parse(artifacts.compose.content);

      // Without this fix, no `ports:` entry would be emitted and the container
      // would silently start without a host binding.
      expect(parsed.services['web-app'].ports).toEqual(['80:80']);
    });

    it('omits ports section when exposedPorts is null', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService({
        exposedPorts: null,
      }) as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');
      const parsed = YAML.parse(artifacts.compose.content);

      expect(parsed.services['web-app'].ports).toBeUndefined();
    });

    it('omits ports section when exposedPorts is an empty array', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService({
        exposedPorts: '[]',
      }) as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');
      const parsed = YAML.parse(artifacts.compose.content);

      expect(parsed.services['web-app'].ports).toBeUndefined();
    });

    it('does not inject ports into custom compose templates', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(baseService({
        composeTemplate: 'services:\n  web-app:\n    image: ${FULL_IMAGE}\n',
        exposedPorts: JSON.stringify([{ host: null, container: 80, protocol: 'tcp' }]),
      }) as any);

      const artifacts = await generateDeploymentArtifacts('svc-1');

      // Custom templates are the source of truth for ports — leave them alone.
      expect(artifacts.compose.content).not.toContain('ports');
      expect(artifacts.compose.content).toContain('registry.com/web-app:v1.0');
    });
  });

  describe('serializeExposedPorts', () => {
    it('returns empty array for null input', () => {
      expect(serializeExposedPorts(null)).toEqual([]);
    });

    it('returns empty array for undefined input', () => {
      expect(serializeExposedPorts(undefined)).toEqual([]);
    });

    it('returns empty array for invalid JSON', () => {
      expect(serializeExposedPorts('not json')).toEqual([]);
    });

    it('returns empty array when payload is not an array', () => {
      expect(serializeExposedPorts('{"host": 80, "container": 80}')).toEqual([]);
    });

    it('formats explicit host:container mapping', () => {
      const json = JSON.stringify([{ host: 8080, container: 80, protocol: 'tcp' }]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('defaults host to container when host is null (issue #117)', () => {
      const json = JSON.stringify([{ host: null, container: 80, protocol: 'tcp' }]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('defaults host to container when host field is missing', () => {
      const json = JSON.stringify([{ container: 443, protocol: 'tcp' }]);
      expect(serializeExposedPorts(json)).toEqual(['443:443']);
    });

    it('appends /udp for udp protocol', () => {
      const json = JSON.stringify([{ host: 53, container: 53, protocol: 'udp' }]);
      expect(serializeExposedPorts(json)).toEqual(['53:53/udp']);
    });

    it('treats missing protocol as tcp (no suffix)', () => {
      const json = JSON.stringify([{ host: 80, container: 80 }]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('lowercases protocol when checking against tcp', () => {
      const json = JSON.stringify([{ host: 80, container: 80, protocol: 'TCP' }]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('deduplicates entries with identical mappings', () => {
      const json = JSON.stringify([
        { host: 8080, container: 80, protocol: 'tcp' },
        { host: 8080, container: 80, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('keeps distinct host ports for the same container port', () => {
      const json = JSON.stringify([
        { host: 8080, container: 80, protocol: 'tcp' },
        { host: 8081, container: 80, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80', '8081:80']);
    });

    it('preserves multiple distinct port mappings', () => {
      const json = JSON.stringify([
        { host: 80, container: 80, protocol: 'tcp' },
        { host: 443, container: 443, protocol: 'tcp' },
        { host: 53, container: 53, protocol: 'udp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['80:80', '443:443', '53:53/udp']);
    });

    it('skips entries with non-numeric container port', () => {
      const json = JSON.stringify([
        { host: 80, container: 'abc' },
        { host: 443, container: 443, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['443:443']);
    });

    it('skips entries with out-of-range container port', () => {
      const json = JSON.stringify([
        { host: null, container: 0 },
        { host: null, container: 65536 },
        { host: null, container: -1 },
        { host: 80, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('skips entries with out-of-range explicit host port', () => {
      const json = JSON.stringify([
        { host: 99999, container: 80 },
        { host: 8080, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('skips entries with non-integer host port', () => {
      const json = JSON.stringify([
        { host: 80.5, container: 80 },
        { host: 8080, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('skips null entries and non-object entries', () => {
      const json = JSON.stringify([
        null,
        'string',
        42,
        { host: 80, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('skips entries with missing container port', () => {
      const json = JSON.stringify([
        { host: 80 },
        { host: 443, container: 443 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['443:443']);
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
