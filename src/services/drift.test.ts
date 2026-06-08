import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandClient, SSHExecResult } from '../lib/ssh.js';
import type { DockerClient } from '../lib/docker.js';

/**
 * Unit tests for read-only drift detection (issue #129).
 *
 * The per-deployment engine (computeDeploymentDrift) is private, so we drive it
 * through the public roll-ups (computeServiceDrift / computeServerDrift /
 * computeEnvironmentDrift). All host IO, the Docker/SSH clients, Prisma, and the
 * artifact/secret helpers are mocked — no real host or DB is touched.
 *
 * Two security invariants are asserted throughout:
 *  1. Content drift never returns raw (secret-bearing) compose/config content.
 *  2. Env drift returns KEY NAMES only, never values.
 *  3. Only read-only commands (docker inspect / cat) ever reach the client.
 */

// ---- mocks (must be declared before importing the module under test) ----

vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
    environment: { findUnique: vi.fn() },
    serviceDeployment: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('../lib/docker.js', () => ({
  createDockerClientForServer: vi.fn(),
}));

vi.mock('../lib/ssh.js', () => ({
  createClientForServer: vi.fn(),
  // Real-ish shellEscape so command strings look like the production output.
  shellEscape: vi.fn((s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue('mock-key'),
}));

vi.mock('./secrets.js', () => ({
  getSecretsForEnv: vi.fn().mockResolvedValue({}),
  resolveSecretPlaceholders: vi.fn(),
}));

// Keep the REAL serializeExposedPorts (the #117 port logic depends on it) but
// mock the IO-heavy generateDeploymentArtifacts.
vi.mock('./compose.js', async () => {
  const actual = await vi.importActual<typeof import('./compose.js')>('./compose.js');
  return {
    serializeExposedPorts: actual.serializeExposedPorts,
    generateDeploymentArtifacts: vi.fn(),
  };
});

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { createClientForServer } from '../lib/ssh.js';
import { getSecretsForEnv, resolveSecretPlaceholders } from './secrets.js';
import { generateDeploymentArtifacts } from './compose.js';
import {
  computeServiceDrift,
  computeServerDrift,
  computeEnvironmentDrift,
} from './drift.js';

const mockPrisma = vi.mocked(prisma, true);
const mockCreateDocker = vi.mocked(createDockerClientForServer);
const mockCreateClient = vi.mocked(createClientForServer);
const mockGetSecrets = vi.mocked(getSecretsForEnv);
const mockResolveSecrets = vi.mocked(resolveSecretPlaceholders);
const mockGenerateArtifacts = vi.mocked(generateDeploymentArtifacts);

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

const MUTATING_VERB = /\b(rm|stop|kill|restart|run|up|down|pull|push|create|exec\s+-|tee|>)\b/;

/**
 * A CommandClient mock that records every command and (optionally) throws if it
 * ever sees a mutating verb — enforcing the read-only invariant at the source.
 */
function makeFileClient(
  responder: (cmd: string) => SSHExecResult,
  opts: { rejectMutations?: boolean } = {}
): { client: CommandClient; calls: string[] } {
  const calls: string[] = [];
  const client: CommandClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (opts.rejectMutations && MUTATING_VERB.test(cmd) && !/2>\/dev\/null/.test(cmd)) {
        throw new Error(`Mutating command reached the host: ${cmd}`);
      }
      // `cat ... 2>/dev/null` redirection contains `>`; treat cat as read-only.
      if (opts.rejectMutations && /\b(rm|stop|kill|restart|docker run|compose up|compose down|pull)\b/.test(cmd)) {
        throw new Error(`Mutating command reached the host: ${cmd}`);
      }
      return responder(cmd);
    }),
    execStream: vi.fn().mockResolvedValue(0),
    writeFile: vi.fn(async () => {
      throw new Error('writeFile is a mutation and must never be called by drift');
    }),
    disconnect: vi.fn(),
  };
  return { client, calls };
}

/** A DockerClient mock — only the read-only methods drift uses are wired up. */
function makeDockerClient(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    listContainers: vi.fn(),
    getContainerInfo: vi.fn(),
    getContainerHealth: vi.fn(),
    getContainerStats: vi.fn(),
    getContainerEnv: vi.fn().mockResolvedValue({}),
    getContainerImageDigests: vi
      .fn()
      .mockResolvedValue({ found: true, imageRef: '', repoDigests: [], configDigest: '' }),
    restartContainer: vi.fn(),
    pullImage: vi.fn(),
    getContainerLogs: vi.fn(),
    ...(overrides as object),
  } as unknown as DockerClient;
}

interface BuildDeploymentOpts {
  id?: string;
  composePath?: string | null;
  exposedPorts?: string | null;
  envOverrides?: string | null;
  manifestDigest?: string | null;
  baseEnv?: string | null;
  files?: Array<{
    serviceDeploymentId?: string | null;
    configFileId: string;
    targetPath: string;
    name: string;
    content?: string;
    isBinary?: boolean;
    language?: string;
  }>;
}

function buildDeployment(opts: BuildDeploymentOpts = {}) {
  const id = opts.id ?? 'dep-1';
  return {
    id,
    serviceId: 'svc-1',
    serverId: 'srv-1',
    containerName: 'web-app',
    composePath: opts.composePath === undefined ? '/opt/app/docker-compose.yml' : opts.composePath,
    envOverrides: opts.envOverrides ?? null,
    exposedPorts: opts.exposedPorts ?? null,
    imageDigestId: opts.manifestDigest ? 'digest-1' : null,
    imageDigest: opts.manifestDigest
      ? { id: 'digest-1', manifestDigest: opts.manifestDigest }
      : null,
    server: {
      id: 'srv-1',
      name: 'prod-1',
      hostname: 'host.example',
      dockerMode: 'ssh',
      serverType: 'remote',
      environmentId: 'env-1',
    },
    service: {
      id: 'svc-1',
      name: 'my-service',
      baseEnv: opts.baseEnv ?? null,
      containerImage: { id: 'img-1', name: 'nginx' },
      files: (opts.files ?? []).map((f) => ({
        serviceDeploymentId: f.serviceDeploymentId ?? null,
        configFileId: f.configFileId,
        targetPath: f.targetPath,
        configFile: {
          id: f.configFileId,
          name: f.name,
          content: f.content ?? '',
          language: f.language ?? 'text',
          isBinary: f.isBinary ?? false,
          includedFragments: [],
        },
      })),
    },
  };
}

type MockDeployment = ReturnType<typeof buildDeployment>;

/** Wire prisma + clients to compute a single deployment's drift via computeServiceDrift. */
function arrangeSingleDeployment(
  deployment: MockDeployment,
  clients: {
    dockerClient?: DockerClient | null;
    fileClient?: CommandClient | null;
    needsConnect?: boolean;
    clientError?: string;
  }
) {
  mockPrisma.service.findUnique.mockResolvedValue({ id: 'svc-1', name: 'my-service' } as never);
  mockPrisma.serviceDeployment.findMany.mockResolvedValue([deployment] as never);
  // siblingCount for shared-compose detection: default to "only me".
  mockPrisma.serviceDeployment.count.mockResolvedValue(1 as never);

  mockCreateDocker.mockResolvedValue({
    dockerClient: clients.dockerClient ?? null,
    sshClient: clients.fileClient ?? null,
    error: clients.clientError,
    mode: 'ssh',
    needsConnect: clients.needsConnect ?? !!clients.fileClient,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSecrets.mockResolvedValue({});
  mockGenerateArtifacts.mockResolvedValue({
    compose: { name: 'docker-compose.yml', content: 'services:\n  web: {}\n', checksum: 'c' },
    configFiles: [],
  } as never);
});

// ---------------------------------------------------------------------------
// composePath
// ---------------------------------------------------------------------------

describe('drift — composePath', () => {
  it('match:true when a compose path is stored (expected==actual)', async () => {
    const dep = buildDeployment({ composePath: '/opt/app/docker-compose.yml' });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const d = result!.deployments[0].drift.composePath;
    expect(d.match).toBe(true);
    expect(d.expected).toBe('/opt/app/docker-compose.yml');
    expect(d.actual).toBe('/opt/app/docker-compose.yml');
  });

  it('match:null with a reason when no compose path is stored', async () => {
    const dep = buildDeployment({ composePath: null });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const d = result!.deployments[0].drift.composePath;
    expect(d.match).toBeNull();
    expect(d.expected).toBeNull();
    expect(d.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// composeContent
// ---------------------------------------------------------------------------

describe('drift — composeContent', () => {
  it('match:true when host compose checksum equals the regenerated compose', async () => {
    const composeText = 'services:\n  web: {}\n';
    mockGenerateArtifacts.mockResolvedValue({
      compose: { name: 'docker-compose.yml', content: composeText, checksum: 'x' },
      configFiles: [],
    } as never);
    const dep = buildDeployment({ composePath: '/opt/app/docker-compose.yml' });
    const { client } = makeFileClient((cmd) =>
      cmd.includes('cat') ? { stdout: composeText, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    expect(result!.deployments[0].drift.composeContent.match).toBe(true);
  });

  it('match:false with a reason and NO raw secret content when content differs', async () => {
    const SECRET = 'super-secret-db-password';
    mockGetSecrets.mockResolvedValue({ DB_PASS: SECRET } as never);
    mockGenerateArtifacts.mockResolvedValue({
      compose: {
        name: 'docker-compose.yml',
        content: `services:\n  web:\n    environment:\n      DB: ${SECRET}\n`,
        checksum: 'x',
      },
      configFiles: [],
    } as never);
    const dep = buildDeployment({ composePath: '/opt/app/docker-compose.yml' });
    // Host file has DIFFERENT (also secret-bearing) content.
    const { client } = makeFileClient((cmd) =>
      cmd.includes('cat')
        ? { stdout: `services:\n  web:\n    environment:\n      DB: ${SECRET}\n      EXTRA: drifted\n`, stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const cc = result!.deployments[0].drift.composeContent;
    expect(cc.match).toBe(false);
    expect(cc.reason).toBeTruthy();
    // SECURITY: neither the secret nor the raw file content may leak.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('EXTRA');
    expect(serialized).not.toContain('drifted');
  });

  it('match:false when the host compose file is missing (cat exits non-zero)', async () => {
    const dep = buildDeployment({ composePath: '/opt/app/docker-compose.yml' });
    const { client } = makeFileClient((cmd) =>
      cmd.includes('cat') ? { stdout: '', stderr: '', code: 1 } : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const cc = result!.deployments[0].drift.composeContent;
    expect(cc.match).toBe(false);
    expect(cc.reason).toMatch(/not found/i);
  });

  it('match:null with a reason for a shared/operator-maintained compose file', async () => {
    const dep = buildDeployment({ composePath: '/opt/shared/docker-compose.yml' });
    const { client } = makeFileClient(() => ({ stdout: 'services:', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });
    // Multiple deployments share this compose path on the server.
    mockPrisma.serviceDeployment.count.mockResolvedValue(2 as never);

    const result = await computeServiceDrift('svc-1');
    const cc = result!.deployments[0].drift.composeContent;
    expect(cc.match).toBeNull();
    expect(cc.reason).toMatch(/shared|operator-maintained/i);
  });
});

// ---------------------------------------------------------------------------
// imageDigest
// ---------------------------------------------------------------------------

describe('drift — imageDigest', () => {
  it('match:false when the recorded digest differs from the host image digest', async () => {
    const dep = buildDeployment({ manifestDigest: 'sha256:expected' });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true,
        imageRef: 'nginx:1.25',
        repoDigests: ['nginx@sha256:actualdifferent'],
        configDigest: 'sha256:local',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const id = result!.deployments[0].drift.imageDigest;
    expect(id.match).toBe(false);
    expect(id.expected).toBe('sha256:expected');
    expect(id.reason).toBeTruthy();
  });

  it('match:true when the recorded digest matches a host RepoDigest sha', async () => {
    const dep = buildDeployment({ manifestDigest: 'sha256:abc123' });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true,
        imageRef: 'nginx:1.25',
        repoDigests: ['nginx@sha256:abc123'],
        configDigest: 'sha256:local',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    expect(result!.deployments[0].drift.imageDigest.match).toBe(true);
  });

  it('match:null (NOT false) when BRIDGEPORT has no recorded digest', async () => {
    const dep = buildDeployment({ manifestDigest: null });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true,
        imageRef: 'nginx:1.25',
        repoDigests: ['nginx@sha256:whatever'],
        configDigest: 'sha256:local',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const id = result!.deployments[0].drift.imageDigest;
    expect(id.match).toBeNull();
    expect(id.reason).toMatch(/no recorded/i);
  });

  it('match:null (NOT false) for a locally-built image with no RepoDigests', async () => {
    const dep = buildDeployment({ manifestDigest: 'sha256:expected' });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true,
        imageRef: 'myapp:dev',
        repoDigests: [],
        configDigest: 'sha256:local',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const id = result!.deployments[0].drift.imageDigest;
    expect(id.match).toBeNull();
    expect(id.reason).toMatch(/no registry digest|locally built/i);
  });

  it('match:false when the container is missing on the host', async () => {
    const dep = buildDeployment({ manifestDigest: 'sha256:expected' });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: false,
        imageRef: '',
        repoDigests: [],
        configDigest: '',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const id = result!.deployments[0].drift.imageDigest;
    expect(id.match).toBe(false);
    expect(id.reason).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// exposedPorts (issue #117)
// ---------------------------------------------------------------------------

describe('drift — exposedPorts', () => {
  it('#117: stored {host:80,container:80} vs host {host:null,container:80} -> match:false', async () => {
    // Stored mapping with an explicit host port.
    const dep = buildDeployment({
      exposedPorts: JSON.stringify([{ host: 80, container: 80 }]),
    });
    const docker = makeDockerClient({
      // Host reports the container port published with NO host binding.
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running',
        running: true,
        image: 'nginx',
        ports: [{ host: null, container: 80, protocol: 'tcp' }],
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const p = result!.deployments[0].drift.exposedPorts;
    expect(p.match).toBe(false);
    expect(p.reason).toBeTruthy();
  });

  it('match:true when published ports equal the stored mapping', async () => {
    const dep = buildDeployment({
      exposedPorts: JSON.stringify([{ host: 8080, container: 80 }]),
    });
    const docker = makeDockerClient({
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running',
        running: true,
        image: 'nginx',
        ports: [{ host: 8080, container: 80, protocol: 'tcp' }],
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    expect(result!.deployments[0].drift.exposedPorts.match).toBe(true);
  });

  it('match:false when the container is not found', async () => {
    const dep = buildDeployment({ exposedPorts: JSON.stringify([{ host: 80, container: 80 }]) });
    const docker = makeDockerClient({
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'not_found',
        running: false,
        image: '',
        ports: [],
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const p = result!.deployments[0].drift.exposedPorts;
    expect(p.match).toBe(false);
    expect(p.reason).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// configFiles
// ---------------------------------------------------------------------------

describe('drift — configFiles', () => {
  it('match:true when host file content matches the rendered config', async () => {
    const rendered = 'server { listen 80; }\n';
    mockGenerateArtifacts.mockResolvedValue({
      compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'c' },
      configFiles: [
        { name: 'nginx.conf', content: rendered, checksum: 'h', mountPath: '/etc/nginx/nginx.conf', isBinary: false },
      ],
    } as never);
    const dep = buildDeployment({
      files: [{ configFileId: 'cf-1', targetPath: '/etc/nginx/nginx.conf', name: 'nginx.conf' }],
    });
    const { client } = makeFileClient((cmd) =>
      cmd.includes('/etc/nginx/nginx.conf') ? { stdout: rendered, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const files = result!.deployments[0].drift.configFiles;
    expect(files).toHaveLength(1);
    expect(files[0].targetPath).toBe('/etc/nginx/nginx.conf');
    expect(files[0].match).toBe(true);
  });

  it('match:false when host file content differs (and no raw content leaks)', async () => {
    mockGenerateArtifacts.mockResolvedValue({
      compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'c' },
      configFiles: [
        { name: 'nginx.conf', content: 'server { listen 80; }\n', checksum: 'h', mountPath: '/etc/nginx/nginx.conf', isBinary: false },
      ],
    } as never);
    const dep = buildDeployment({
      files: [{ configFileId: 'cf-1', targetPath: '/etc/nginx/nginx.conf', name: 'nginx.conf' }],
    });
    const { client } = makeFileClient((cmd) =>
      cmd.includes('/etc/nginx/nginx.conf')
        ? { stdout: 'server { listen 8080; tampered_directive; }\n', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const files = result!.deployments[0].drift.configFiles;
    expect(files[0].match).toBe(false);
    expect(files[0].reason).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('tampered_directive');
  });

  it('reason populated when the host config file is missing', async () => {
    mockGenerateArtifacts.mockResolvedValue({
      compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'c' },
      configFiles: [
        { name: 'nginx.conf', content: 'x\n', checksum: 'h', mountPath: '/etc/nginx/nginx.conf', isBinary: false },
      ],
    } as never);
    const dep = buildDeployment({
      files: [{ configFileId: 'cf-1', targetPath: '/etc/nginx/nginx.conf', name: 'nginx.conf' }],
    });
    const { client } = makeFileClient((cmd) =>
      cmd.includes('/etc/nginx/nginx.conf') ? { stdout: '', stderr: '', code: 1 } : { stdout: '', stderr: '', code: 0 }
    );
    arrangeSingleDeployment(dep, { dockerClient: makeDockerClient(), fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const files = result!.deployments[0].drift.configFiles;
    expect(files[0].match).toBe(false);
    expect(files[0].reason).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// envVars (managed keys only; never values)
// ---------------------------------------------------------------------------

describe('drift — envVars', () => {
  it('reports a managed key missing on host in `missing` (keys only)', async () => {
    const dep = buildDeployment({
      baseEnv: JSON.stringify({ APP_MODE: 'prod', LOG_LEVEL: 'info' }),
    });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockResolvedValue({
        APP_MODE: 'prod',
        // LOG_LEVEL absent on host
        PATH: '/usr/bin', // image-baked, must be ignored
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const env = result!.deployments[0].drift.envVars;
    expect(env.missing).toEqual(['LOG_LEVEL']);
    expect(env.unexpected).toEqual([]);
    expect(env.match).toBe(false);
  });

  it('reports a managed key with a differing host value in `unexpected` (KEY only, never value)', async () => {
    const SECRET_EXPECTED = 'expected-secret-value';
    const SECRET_ACTUAL = 'actual-host-secret-value';
    mockGetSecrets.mockResolvedValue({ API_KEY: SECRET_EXPECTED } as never);
    const dep = buildDeployment({
      baseEnv: JSON.stringify({ API_KEY: SECRET_EXPECTED }),
    });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockResolvedValue({
        API_KEY: SECRET_ACTUAL, // differs
        HOSTNAME: 'abc123', // injected, ignored
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const env = result!.deployments[0].drift.envVars;
    expect(env.unexpected).toEqual(['API_KEY']);
    expect(env.missing).toEqual([]);
    expect(env.match).toBe(false);
    // SECURITY: neither the expected nor the host env value may leak anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_EXPECTED);
    expect(serialized).not.toContain(SECRET_ACTUAL);
  });

  it('ignores image-baked / injected vars BridgePort does not manage (PATH, HOSTNAME)', async () => {
    const dep = buildDeployment({
      baseEnv: JSON.stringify({ APP_MODE: 'prod' }),
    });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockResolvedValue({
        APP_MODE: 'prod',
        PATH: '/usr/local/sbin:/usr/bin',
        HOSTNAME: 'a1b2c3',
        TERM: 'xterm',
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const env = result!.deployments[0].drift.envVars;
    expect(env.missing).toEqual([]);
    expect(env.unexpected).toEqual([]);
    expect(env.match).toBe(true);
  });

  it('overrides win over baseEnv for the expected managed value', async () => {
    const dep = buildDeployment({
      baseEnv: JSON.stringify({ LOG_LEVEL: 'info' }),
      envOverrides: JSON.stringify({ LOG_LEVEL: 'debug' }),
    });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockResolvedValue({ LOG_LEVEL: 'debug' }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    expect(result!.deployments[0].drift.envVars.match).toBe(true);
  });

  it('match:false with a reason when the container is not found (env null)', async () => {
    const dep = buildDeployment({ baseEnv: JSON.stringify({ APP_MODE: 'prod' }) });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockResolvedValue(null),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const env = result!.deployments[0].drift.envVars;
    expect(env.match).toBe(false);
    expect(env.reason).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// summary counting
// ---------------------------------------------------------------------------

describe('drift — summary', () => {
  it('counts only match:false fields, not match:null', async () => {
    // Arrange a deployment with: imageDigest=false (mismatch), ports=false,
    // composeContent=null (shared file), envVars=match true.
    const dep = buildDeployment({
      composePath: '/opt/shared/docker-compose.yml',
      manifestDigest: 'sha256:expected',
      exposedPorts: JSON.stringify([{ host: 80, container: 80 }]),
      baseEnv: JSON.stringify({ APP_MODE: 'prod' }),
    });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true,
        imageRef: 'nginx',
        repoDigests: ['nginx@sha256:different'],
        configDigest: 'sha256:local',
      }),
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running',
        running: true,
        image: 'nginx',
        ports: [{ host: 9999, container: 80, protocol: 'tcp' }], // drift
      }),
      getContainerEnv: vi.fn().mockResolvedValue({ APP_MODE: 'prod' }),
    });
    const { client } = makeFileClient(() => ({ stdout: 'whatever', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });
    mockPrisma.serviceDeployment.count.mockResolvedValue(2 as never); // shared compose -> null

    const result = await computeServiceDrift('svc-1');
    const d = result!.deployments[0];
    expect(d.drift.imageDigest.match).toBe(false);
    expect(d.drift.exposedPorts.match).toBe(false);
    expect(d.drift.composeContent.match).toBeNull(); // not counted
    expect(d.drift.envVars.match).toBe(true);
    // 2 false fields => "2 drift items detected"
    expect(d.summary).toBe('2 drift items detected');
    expect(result!.summary).toBe('2 drift items detected');
  });

  it('reports 0 drift items when everything matches or is unresolved', async () => {
    const dep = buildDeployment({
      composePath: null, // composeContent null
      manifestDigest: null, // imageDigest null
      exposedPorts: null, // no expected ports; host has none -> match
      baseEnv: null,
    });
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true, imageRef: 'nginx', repoDigests: ['nginx@sha256:x'], configDigest: 'sha256:l',
      }),
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running', running: true, image: 'nginx', ports: [],
      }),
      getContainerEnv: vi.fn().mockResolvedValue({ PATH: '/usr/bin' }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    expect(result!.deployments[0].summary).toBe('0 drift items detected');
  });
});

// ---------------------------------------------------------------------------
// host unreachable
// ---------------------------------------------------------------------------

describe('drift — host unreachable', () => {
  it('degrades affected fields to match:null with warnings, does not throw', async () => {
    const dep = buildDeployment({
      composePath: '/opt/app/docker-compose.yml',
      manifestDigest: 'sha256:expected',
      exposedPorts: JSON.stringify([{ host: 80, container: 80 }]),
      baseEnv: JSON.stringify({ APP_MODE: 'prod' }),
    });
    // No docker client and no file client — host unreachable.
    arrangeSingleDeployment(dep, {
      dockerClient: null,
      fileClient: null,
      clientError: 'connection refused',
    });
    // When the factory returns no sshClient, drift falls back to
    // createClientForServer; that also fails for an unreachable host.
    mockCreateClient.mockResolvedValue({ client: null, error: 'connection refused' } as never);

    const result = await computeServiceDrift('svc-1');
    const d = result!.deployments[0].drift;
    expect(d.imageDigest.match).toBeNull();
    expect(d.exposedPorts.match).toBeNull();
    expect(d.envVars.match).toBeNull();
    expect(d.composeContent.match).toBeNull();
    // composePath is the stored source of truth and still resolves to true.
    expect(d.composePath.match).toBe(true);
    expect(result!.deployments[0].summary).toBe('0 drift items detected');
  });

  it('degrades to match:null when getContainerEnv throws (transient error)', async () => {
    const dep = buildDeployment({ baseEnv: JSON.stringify({ APP_MODE: 'prod' }) });
    const docker = makeDockerClient({
      getContainerEnv: vi.fn().mockRejectedValue(new Error('inspect timeout')),
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true, imageRef: 'nginx', repoDigests: [], configDigest: '',
      }),
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running', running: true, image: 'nginx', ports: [],
      }),
    });
    const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    const result = await computeServiceDrift('svc-1');
    const env = result!.deployments[0].drift.envVars;
    expect(env.match).toBeNull();
    expect(env.reason).toMatch(/inspect timeout|could not inspect/i);
  });
});

// ---------------------------------------------------------------------------
// read-only invariant
// ---------------------------------------------------------------------------

describe('drift — read-only invariant', () => {
  it('only ever issues cat / docker inspect; never a mutating command or writeFile', async () => {
    const dep = buildDeployment({
      composePath: '/opt/app/docker-compose.yml',
      manifestDigest: 'sha256:expected',
      exposedPorts: JSON.stringify([{ host: 80, container: 80 }]),
      baseEnv: JSON.stringify({ APP_MODE: 'prod' }),
      files: [{ configFileId: 'cf-1', targetPath: '/etc/app/app.conf', name: 'app.conf' }],
    });
    mockGenerateArtifacts.mockResolvedValue({
      compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'c' },
      configFiles: [
        { name: 'app.conf', content: 'k=v\n', checksum: 'h', mountPath: '/etc/app/app.conf', isBinary: false },
      ],
    } as never);
    const docker = makeDockerClient({
      getContainerImageDigests: vi.fn().mockResolvedValue({
        found: true, imageRef: 'nginx', repoDigests: ['nginx@sha256:expected'], configDigest: 'sha256:l',
      }),
      getContainerInfo: vi.fn().mockResolvedValue({
        state: 'running', running: true, image: 'nginx', ports: [{ host: 80, container: 80, protocol: 'tcp' }],
      }),
      getContainerEnv: vi.fn().mockResolvedValue({ APP_MODE: 'prod' }),
    });
    const { client, calls } = makeFileClient(
      () => ({ stdout: 'k=v\n', stderr: '', code: 0 }),
      { rejectMutations: true }
    );
    arrangeSingleDeployment(dep, { dockerClient: docker, fileClient: client });

    await computeServiceDrift('svc-1');

    expect(calls.length).toBeGreaterThan(0);
    for (const cmd of calls) {
      // Only `cat <path> 2>/dev/null` style reads are expected here.
      expect(cmd).toMatch(/^cat /);
    }
    expect(client.writeFile).not.toHaveBeenCalled();
    // Docker drift methods used are the read-only ones.
    expect(docker.restartContainer).not.toHaveBeenCalled();
    expect(docker.pullImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// roll-ups
// ---------------------------------------------------------------------------

describe('drift — roll-ups', () => {
  it('computeServiceDrift returns null for a missing service', async () => {
    mockPrisma.service.findUnique.mockResolvedValue(null as never);
    expect(await computeServiceDrift('nope')).toBeNull();
  });

  it('computeServerDrift returns null for a missing server', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(null as never);
    expect(await computeServerDrift('nope')).toBeNull();
  });

  it('computeEnvironmentDrift returns null for a missing environment', async () => {
    mockPrisma.environment.findUnique.mockResolvedValue(null as never);
    expect(await computeEnvironmentDrift('nope')).toBeNull();
  });

  it('computeServerDrift aggregates across deployments and tallies total drift', async () => {
    const dep1 = buildDeployment({
      id: 'dep-1',
      manifestDigest: 'sha256:e1',
      composePath: null,
      baseEnv: null,
    });
    const dep2 = buildDeployment({
      id: 'dep-2',
      manifestDigest: 'sha256:e2',
      composePath: null,
      baseEnv: null,
    });
    mockPrisma.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'prod-1' } as never);
    mockPrisma.serviceDeployment.findMany.mockResolvedValue([dep1, dep2] as never);
    mockPrisma.serviceDeployment.count.mockResolvedValue(1 as never);

    let call = 0;
    mockCreateDocker.mockImplementation(async () => {
      call++;
      const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
      return {
        dockerClient: makeDockerClient({
          // dep-1 image drifts; dep-2 matches.
          getContainerImageDigests: vi.fn().mockResolvedValue({
            found: true,
            imageRef: 'nginx',
            repoDigests: [call === 1 ? 'nginx@sha256:WRONG' : 'nginx@sha256:e2'],
            configDigest: 'sha256:l',
          }),
          getContainerInfo: vi.fn().mockResolvedValue({
            state: 'running', running: true, image: 'nginx', ports: [],
          }),
          getContainerEnv: vi.fn().mockResolvedValue({}),
        }),
        sshClient: client,
        mode: 'ssh',
        needsConnect: true,
      } as never;
    });

    const result = await computeServerDrift('srv-1');
    expect(result!.deployments).toHaveLength(2);
    // dep-1 has one drift item (image), dep-2 has none.
    expect(result!.summary).toBe('1 drift item detected');
  });

  it('computeEnvironmentDrift groups deployments by service and does not crash when one errors', async () => {
    const depA = buildDeployment({ id: 'dep-a', composePath: null, baseEnv: null, manifestDigest: null });
    const depB = buildDeployment({ id: 'dep-b', composePath: null, baseEnv: null, manifestDigest: null });
    // depB belongs to a different service.
    (depB as { serviceId: string }).serviceId = 'svc-2';
    (depB as { service: { id: string; name: string } }).service.id = 'svc-2';
    (depB as { service: { id: string; name: string } }).service.name = 'other-service';

    mockPrisma.environment.findUnique.mockResolvedValue({ id: 'env-1' } as never);
    mockPrisma.serviceDeployment.findMany.mockResolvedValue([depA, depB] as never);
    mockPrisma.serviceDeployment.count.mockResolvedValue(1 as never);

    let call = 0;
    mockCreateDocker.mockImplementation(async () => {
      call++;
      // The FIRST deployment's host inspection blows up (connect rejects). The
      // per-deployment engine catches it and degrades to a warning, so the
      // roll-up must still complete for the others.
      const failing = call === 1;
      const { client } = makeFileClient(() => ({ stdout: '', stderr: '', code: 0 }));
      if (failing) {
        (client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connect blew up'));
      }
      return {
        dockerClient: makeDockerClient(),
        sshClient: client,
        mode: 'ssh',
        needsConnect: true,
      } as never;
    });

    const result = await computeEnvironmentDrift('env-1');
    expect(result).not.toBeNull();
    // Two distinct services in the env.
    expect(result!.services.map((s) => s.serviceId).sort()).toEqual(['svc-1', 'svc-2']);
    // Each service has exactly one deployment.
    for (const s of result!.services) {
      expect(s.deployments).toHaveLength(1);
    }
    // The errored deployment degrades to warnings, not a thrown roll-up.
    const allWarnings = result!.services.flatMap((s) => s.deployments.flatMap((d) => d.warnings));
    expect(allWarnings.some((w) => /connect blew up|inspection failed/i.test(w))).toBe(true);
  });
});

// keep the unused import referenced (resolveSecretPlaceholders is wired for
// fallback config rendering paths not exercised above).
void mockResolveSecrets;
