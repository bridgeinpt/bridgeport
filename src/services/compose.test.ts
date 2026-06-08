import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    serviceDeployment: { findUniqueOrThrow: vi.fn() },
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
  resolveSecretPlaceholders: vi.fn().mockResolvedValue({ content: 'resolved', missing: [], templateErrors: [] }),
  getSecretsForEnv: vi.fn().mockResolvedValue({}),
}));

import YAML from 'yaml';
import { prisma } from '../lib/db.js';
import {
  generateDeploymentArtifacts,
  previewDryRunArtifacts,
  saveDeploymentArtifacts,
  getDeploymentArtifacts,
  serializeExposedPorts,
  validateGeneratedCompose,
} from './compose.js';
import { resolveSecretPlaceholders } from './secrets.js';

const mockPrisma = vi.mocked(prisma);

interface BuildDeploymentOptions {
  // Service template fields
  serviceName?: string;
  imageName?: string;
  imageTag?: string;
  composeTemplate?: string | null;
  baseEnv?: string | null;
  // Per-deployment fields
  containerName?: string;
  composePath?: string | null;
  envOverrides?: string | null;
  exposedPorts?: string | null;
  files?: Array<Record<string, unknown>>;
}

/**
 * Build a ServiceDeployment row (with included service + server) as Prisma would return it.
 * Note: the new shape is `serviceDeployment.findUniqueOrThrow` with `service` nested.
 */
function buildDeployment(overrides: BuildDeploymentOptions = {}) {
  return {
    id: 'dep-1',
    serviceId: 'svc-1',
    serverId: 'srv-1',
    containerName: overrides.containerName ?? 'web-app-prod',
    composePath: overrides.composePath ?? null,
    envOverrides: overrides.envOverrides ?? null,
    exposedPorts: overrides.exposedPorts ?? null,
    status: 'unknown',
    server: {
      id: 'srv-1',
      hostname: 'prod.local',
      name: 'prod-server',
      environmentId: 'env-1',
      environment: { id: 'env-1', name: 'Production' },
    },
    service: {
      id: 'svc-1',
      name: overrides.serviceName ?? 'web-app',
      imageTag: overrides.imageTag ?? 'v1.0',
      composeTemplate: overrides.composeTemplate ?? null,
      baseEnv: overrides.baseEnv ?? null,
      containerImage: {
        id: 'img-1',
        imageName: overrides.imageName ?? 'registry.com/web-app',
        tagFilter: overrides.imageTag ?? 'v1.0',
      },
      files: overrides.files ?? [],
    },
  };
}

describe('compose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateDeploymentArtifacts', () => {
    it('generates a default compose file using the deployment containerName (not the service name)', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ serviceName: 'web-app', containerName: 'web-app-prod-server' }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);

      // The default generator keys the compose SERVICE on the deployment's
      // containerName (not the parent template's name): the deploy path runs
      // `docker compose up <containerName>`, so the key must match (issue #200).
      expect(parsed.services['web-app-prod-server']).toBeDefined();
      expect(parsed.services['web-app']).toBeUndefined();
      // The per-deployment containerName must also flow into compose's
      // container_name, not the parent template's name.
      expect(parsed.services['web-app-prod-server'].container_name).toBe('web-app-prod-server');
      expect(artifacts.compose.name).toBe('docker-compose.web-app.yml');
    });

    it('substitutes CONTAINER_NAME with the deployment containerName in custom templates', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          composeTemplate: 'services:\n  web:\n    image: ${FULL_IMAGE}\n    container_name: ${CONTAINER_NAME}\n',
          containerName: 'custom-name-on-server-b',
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      expect(artifacts.compose.content).toContain('container_name: custom-name-on-server-b');
      expect(artifacts.compose.content).toContain('registry.com/web-app:v1.0');
    });

    it('merges baseEnv + envOverrides with overrides winning, and writes them to the compose env', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          baseEnv: JSON.stringify({ A: '1', B: '2', C: '3' }),
          envOverrides: JSON.stringify({ B: '99', D: '4' }),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);

      // baseEnv: {A:1, B:2, C:3}; overrides: {B:99, D:4} -> {A:1, B:99, C:3, D:4}
      // Service key is the deployment's containerName (default 'web-app-prod').
      expect(parsed.services['web-app-prod'].environment).toEqual({
        A: '1',
        B: '99',
        C: '3',
        D: '4',
      });
    });

    it('uses only baseEnv when envOverrides is null', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          baseEnv: JSON.stringify({ A: '1', B: '2' }),
          envOverrides: null,
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].environment).toEqual({ A: '1', B: '2' });
    });

    it('uses only envOverrides when baseEnv is null', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          baseEnv: null,
          envOverrides: JSON.stringify({ X: '10' }),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].environment).toEqual({ X: '10' });
    });

    it('omits the environment section when both baseEnv and envOverrides are null/empty', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ baseEnv: null, envOverrides: null }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].environment).toBeUndefined();
    });

    it('falls back to empty env when baseEnv contains invalid JSON (no throw)', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          baseEnv: '{not valid json',
          envOverrides: JSON.stringify({ K: 'v' }),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      // baseEnv was malformed -> safeJsonParse returns {}; overrides still apply.
      expect(parsed.services['web-app-prod'].environment).toEqual({ K: 'v' });
    });

    it('falls back to empty env when envOverrides contains invalid JSON (no throw, baseEnv still applies)', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          baseEnv: JSON.stringify({ A: '1' }),
          envOverrides: 'garbage',
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].environment).toEqual({ A: '1' });
    });

    it('includes ports section from discovered exposedPorts on the deployment', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          exposedPorts: JSON.stringify([{ host: 8080, container: 80, protocol: 'tcp' }]),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].ports).toEqual(['8080:80']);
    });

    it('defaults host port to container port when host is null (issue #117)', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          exposedPorts: JSON.stringify([{ host: null, container: 80, protocol: 'tcp' }]),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].ports).toEqual(['80:80']);
    });

    it('preserves a non-wildcard host IP', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          exposedPorts: JSON.stringify([
            { hostIp: '127.0.0.1', host: 8080, container: 80, protocol: 'tcp' },
          ]),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].ports).toEqual(['127.0.0.1:8080:80']);
    });

    it('fails the build when a config file has template errors', async () => {
      const { resolveSecretPlaceholders } = await import('./secrets.js');
      vi.mocked(resolveSecretPlaceholders).mockResolvedValueOnce({
        content: '',
        missing: [],
        templateErrors: ['Nested {{range}} blocks are not supported'],
      });

      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          files: [
            {
              configFileId: 'cf-tpl-err',
              serviceDeploymentId: null,
              targetPath: '/etc/app.conf',
              configFile: {
                filename: 'app.conf',
                content: '{{range servers tag="web"}}{{range servers tag="db"}}x{{end}}{{end}}',
                isBinary: false,
                // New post-#115 relation — render paths concatenate fragments
                // before placeholder substitution. Empty here means no fragments.
                includedFragments: [],
              },
            },
          ],
        }) as any
      );

      await expect(generateDeploymentArtifacts('dep-1')).rejects.toThrow(/template errors/);
    });

    it('omits ports section when exposedPorts is null', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ exposedPorts: null }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].ports).toBeUndefined();
    });

    it('omits ports section when exposedPorts is an empty array', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ exposedPorts: '[]' }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);
      expect(parsed.services['web-app-prod'].ports).toBeUndefined();
    });

    it('does not inject ports into custom compose templates', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          composeTemplate: 'services:\n  web-app:\n    image: ${FULL_IMAGE}\n',
          exposedPorts: JSON.stringify([{ host: null, container: 80, protocol: 'tcp' }]),
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      // Custom templates are the source of truth for ports — leave them alone.
      expect(artifacts.compose.content).not.toContain('ports');
      expect(artifacts.compose.content).toContain('registry.com/web-app:v1.0');
    });

    it('picks per-deployment override ServiceFile over the base file when both exist for the same ConfigFile', async () => {
      // Two ServiceFile rows for the same configFileId: a base (serviceDeploymentId=null)
      // and a per-deployment override (serviceDeploymentId='dep-1'). The override wins.
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          files: [
            {
              configFileId: 'cf-1',
              serviceDeploymentId: null,
              targetPath: '/etc/app/config.json',
              configFile: { filename: 'config.json', content: 'BASE', isBinary: false, includedFragments: [] },
            },
            {
              configFileId: 'cf-1',
              serviceDeploymentId: 'dep-1',
              targetPath: '/etc/app/config.override.json',
              configFile: { filename: 'config.json', content: 'OVERRIDE', isBinary: false, includedFragments: [] },
            },
          ],
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      expect(artifacts.configFiles).toHaveLength(1);
      expect(artifacts.configFiles[0].mountPath).toBe('/etc/app/config.override.json');
    });
  });

  describe('serializeExposedPorts', () => {
    it('returns empty array for null/undefined input', () => {
      expect(serializeExposedPorts(null)).toEqual([]);
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

    it('appends /udp for udp protocol', () => {
      const json = JSON.stringify([{ host: 53, container: 53, protocol: 'udp' }]);
      expect(serializeExposedPorts(json)).toEqual(['53:53/udp']);
    });

    it('deduplicates entries with identical mappings', () => {
      const json = JSON.stringify([
        { host: 8080, container: 80, protocol: 'tcp' },
        { host: 8080, container: 80, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('preserves multiple distinct port mappings', () => {
      const json = JSON.stringify([
        { host: 80, container: 80, protocol: 'tcp' },
        { host: 443, container: 443, protocol: 'tcp' },
        { host: 53, container: 53, protocol: 'udp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['80:80', '443:443', '53:53/udp']);
    });

    it('skips entries with non-numeric or out-of-range ports', () => {
      const json = JSON.stringify([
        { host: 80, container: 'abc' },
        { host: 99999, container: 80 },
        { host: null, container: 0 },
        { host: 80, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });

    it('rejects non-numeric values without coercion', () => {
      const json = JSON.stringify([
        { host: '8080', container: 80 },
        { host: 80, container: '80' },
        { host: 8080, container: 80 },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('omits wildcard hostIp so docker-compose default applies', () => {
      expect(
        serializeExposedPorts(JSON.stringify([{ hostIp: '0.0.0.0', host: 8080, container: 80 }]))
      ).toEqual(['8080:80']);
      expect(
        serializeExposedPorts(JSON.stringify([{ hostIp: '::', host: 8080, container: 80 }]))
      ).toEqual(['8080:80']);
      expect(
        serializeExposedPorts(JSON.stringify([{ hostIp: '', host: 8080, container: 80 }]))
      ).toEqual(['8080:80']);
    });

    it('brackets IPv6 hostIp in the compose port string', () => {
      const json = JSON.stringify([
        { hostIp: '::1', host: 8080, container: 80, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['[::1]:8080:80']);
    });

    it('collapses IPv4/IPv6 wildcard dual-stack to a single entry', () => {
      const json = JSON.stringify([
        { hostIp: '0.0.0.0', host: 8080, container: 80, protocol: 'tcp' },
        { hostIp: '::', host: 8080, container: 80, protocol: 'tcp' },
      ]);
      expect(serializeExposedPorts(json)).toEqual(['8080:80']);
    });

    it('falls back to tcp for unknown protocols rather than emitting invalid suffix', () => {
      const json = JSON.stringify([{ host: 80, container: 80, protocol: 'garbage' }]);
      expect(serializeExposedPorts(json)).toEqual(['80:80']);
    });
  });

  describe('saveDeploymentArtifacts', () => {
    it('saves artifacts for a deployment via createMany', async () => {
      mockPrisma.deploymentArtifact.createMany.mockResolvedValue({ count: 1 });

      await saveDeploymentArtifacts('dep-1', {
        compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'abc123' },
        configFiles: [],
      });

      expect(mockPrisma.deploymentArtifact.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            type: 'compose',
            name: 'docker-compose.yml',
            deploymentId: 'dep-1',
          }),
        ],
      });
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
      expect(await getDeploymentArtifacts('dep-1')).toEqual([]);
    });
  });

  describe('template variable substitution', () => {
    // Regression: the previous regex-based substitution
    // (`replace(regex, value)`) interpreted `$&`, `$$`, `$1`, etc. in `value`
    // as backreferences. With a function replacer, `$`-sequences in the
    // substituted value are inserted literally.
    it('substitutes template values containing `$&` literally without regex backreference interpretation', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          // ContainerName carries the troublesome `$&` sequence — if regex
          // backreferences were honored, the output would contain the matched
          // `${CONTAINER_NAME}` token rather than the literal `$&`.
          containerName: 'foo$&bar',
          composeTemplate: 'services:\n  web:\n    container_name: ${CONTAINER_NAME}\n',
        }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      expect(artifacts.compose.content).toContain('container_name: foo$&bar');
      expect(artifacts.compose.content).not.toContain('${CONTAINER_NAME}');
    });
  });

  describe('previewDryRunArtifacts', () => {
    it('honors options.imageTag override for IMAGE_TAG / FULL_IMAGE in template substitution', async () => {
      // The Service template carries `imageTag: 'v1.0'`, but the dry-run is
      // invoked with `imageTag: 'v2.0'`. The substituted template MUST use
      // the override — otherwise plan dry-runs would preview the current
      // Service tag, not `step.targetTag`.
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          imageTag: 'v1.0',
          imageName: 'registry.com/web-app',
          composeTemplate: 'services:\n  web:\n    image: ${FULL_IMAGE}\n    labels:\n      tag: ${IMAGE_TAG}\n',
        }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1', { imageTag: 'v2.0' });

      expect(preview.composeContent).toContain('registry.com/web-app:v2.0');
      expect(preview.composeContent).toContain('tag: v2.0');
      expect(preview.composeContent).not.toContain('v1.0');
    });

    it('honors options.imageTag override for the default-compose image field', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ imageTag: 'v1.0', imageName: 'registry.com/web-app' }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1', { imageTag: 'v2.0' });
      const parsed = YAML.parse(preview.composeContent);
      expect(parsed.services['web-app-prod'].image).toBe('registry.com/web-app:v2.0');
    });

    it('falls back to service.imageTag when no override is provided', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ imageTag: 'v3.0', imageName: 'registry.com/web-app' }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1');
      const parsed = YAML.parse(preview.composeContent);
      expect(parsed.services['web-app-prod'].image).toBe('registry.com/web-app:v3.0');
    });

    it('sets wouldFail when a config file has missing secrets (live path would refuse)', async () => {
      vi.mocked(resolveSecretPlaceholders).mockResolvedValueOnce({
        content: 'token=${MISSING}',
        missing: ['MISSING'],
        templateErrors: [],
      });
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          files: [
            {
              configFileId: 'cf-1',
              serviceDeploymentId: null,
              targetPath: '/etc/app/config',
              configFile: { filename: 'config', content: 'token=${MISSING}', isBinary: false, includedFragments: [] },
            },
          ],
        }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1');

      expect(preview.wouldFail).toBe(true);
      expect(preview.failureReason).toMatch(/MISSING/);
      // Warnings keep the human-readable form for back-compat surfaces.
      expect(preview.warnings.some((w) => /MISSING/.test(w))).toBe(true);
    });

    it('sets wouldFail when a config file has template errors (live path would throw)', async () => {
      vi.mocked(resolveSecretPlaceholders).mockResolvedValueOnce({
        content: 'partial',
        missing: [],
        templateErrors: ['malformed range'],
      });
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({
          files: [
            {
              configFileId: 'cf-1',
              serviceDeploymentId: null,
              targetPath: '/etc/app/config',
              configFile: { filename: 'config', content: '{{range bad}}', isBinary: false, includedFragments: [] },
            },
          ],
        }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1');

      expect(preview.wouldFail).toBe(true);
      expect(preview.failureReason).toMatch(/template errors/i);
    });

    it('does NOT set wouldFail on the happy path (no missing secrets, no template errors)', async () => {
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ imageTag: 'v1.0' }) as any
      );

      const preview = await previewDryRunArtifacts('dep-1');
      expect(preview.wouldFail).toBeUndefined();
      expect(preview.failureReason).toBeUndefined();
    });
  });

  // issue #200: the deploy path runs `docker compose pull/up <containerName>`,
  // so the compose document MUST define a service keyed exactly on the
  // deployment's containerName, or compose aborts with "No such service" while
  // the stale container keeps running. validateGeneratedCompose enforces this
  // before deploy.
  describe('validateGeneratedCompose', () => {
    it('returns null when a service is keyed exactly on the containerName', () => {
      const yaml = [
        'services:',
        '  web-prod:',
        '    image: registry.com/web:v1',
        '    container_name: web-prod',
        '',
      ].join('\n');
      expect(validateGeneratedCompose(yaml, 'web-prod')).toBeNull();
    });

    it('returns an actionable error when the only service key != containerName (the mismatch bug)', () => {
      // This is the exact stale-config trap: a single-service compose keyed on
      // the SERVICE name ("web-app") while the deploy targets the CONTAINER name
      // ("web-app-prod"). Must be rejected with a clear, actionable message.
      const yaml = [
        'services:',
        '  web-app:',
        '    image: registry.com/web:v1',
        '    container_name: web-app-prod',
        '',
      ].join('\n');

      const error = validateGeneratedCompose(yaml, 'web-app-prod');
      expect(error).not.toBeNull();
      // Mentions the expected target, the actual keys, and how to fix it.
      expect(error).toContain('web-app-prod');
      expect(error).toContain('web-app');
      expect(error).toMatch(/rename the service|keyed exactly/i);
    });

    it('passes a shared compose file when ONE of several service keys matches the containerName', () => {
      // Shared/hand-maintained file backing multiple BRIDGEPORT deployments.
      const yaml = [
        'services:',
        '  api-prod:',
        '    image: registry.com/api:v1',
        '  web-prod:',
        '    image: registry.com/web:v1',
        '  worker-prod:',
        '    image: registry.com/worker:v1',
        '',
      ].join('\n');
      expect(validateGeneratedCompose(yaml, 'web-prod')).toBeNull();
    });

    it('fails a shared compose file when NONE of the service keys match the containerName', () => {
      const yaml = [
        'services:',
        '  api-prod:',
        '    image: registry.com/api:v1',
        '  worker-prod:',
        '    image: registry.com/worker:v1',
        '',
      ].join('\n');

      const error = validateGeneratedCompose(yaml, 'web-prod');
      expect(error).not.toBeNull();
      expect(error).toContain('web-prod');
      // The actual service keys should be surfaced for debugging.
      expect(error).toContain('api-prod');
      expect(error).toContain('worker-prod');
    });

    it('reports a clear error when there is no services: section', () => {
      const yaml = 'version: "3"\nvolumes:\n  data: {}\n';
      const error = validateGeneratedCompose(yaml, 'web-prod');
      expect(error).not.toBeNull();
      expect(error).toMatch(/no "services:" section/i);
    });

    it('reports a clear error when the content is not valid YAML', () => {
      const error = validateGeneratedCompose('services: [unterminated', 'web-prod');
      expect(error).not.toBeNull();
      expect(error).toMatch(/not valid YAML/i);
    });

    it('reports a clear error when the document does not parse to an object', () => {
      // A scalar YAML document (no top-level mapping) is not a compose document.
      const error = validateGeneratedCompose('just-a-string', 'web-prod');
      expect(error).not.toBeNull();
      expect(error).toMatch(/did not parse to a compose document/i);
    });

    it('the DEFAULT generator produces a compose whose service key passes validation (regression for service.name bug)', async () => {
      // Generate a default (non-template) compose where the SERVICE name and the
      // deployment containerName differ — the exact condition that triggered the
      // original mismatch. The generated artifact must validate cleanly.
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(
        buildDeployment({ serviceName: 'web-app', containerName: 'web-app-prod' }) as any
      );

      const artifacts = await generateDeploymentArtifacts('dep-1');
      const parsed = YAML.parse(artifacts.compose.content);

      // Service key equals the containerName, NOT the service name.
      expect(Object.keys(parsed.services)).toEqual(['web-app-prod']);
      // And feeding the generated content back through the validator passes.
      expect(validateGeneratedCompose(artifacts.compose.content, 'web-app-prod')).toBeNull();
    });
  });
});
