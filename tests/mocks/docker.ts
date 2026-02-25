/**
 * Mock Docker client for tests.
 *
 * Provides a configurable mock that implements the DockerClient interface.
 * Allows tests to set up expected container states and control failures.
 */
import { vi } from 'vitest';
import type {
  DockerClient,
  ContainerInfo,
  ContainerDetails,
  ContainerHealth,
  ContainerStats,
} from '../../src/lib/docker.js';

export interface MockDockerOptions {
  /** Default containers to return from listContainers */
  containers?: ContainerInfo[];
  /** Container details keyed by container name */
  containerDetails?: Record<string, ContainerDetails>;
  /** Container health results keyed by container name */
  containerHealth?: Record<string, ContainerHealth>;
  /** Container stats keyed by container name */
  containerStats?: Record<string, ContainerStats>;
  /** Container names that should fail operations */
  failOnContainers?: Set<string>;
}

export function createMockDocker(options: MockDockerOptions = {}): DockerClient & {
  /** Set container to fail on operations */
  failOnContainer: (name: string) => void;
  /** Set health check result for a container */
  setHealthCheckResult: (name: string, healthy: boolean) => void;
  /** Add a container to the list */
  addContainer: (info: ContainerInfo) => void;
  /** Get call history */
  calls: {
    listContainers: ReturnType<typeof vi.fn>;
    getContainerInfo: ReturnType<typeof vi.fn>;
    getContainerHealth: ReturnType<typeof vi.fn>;
    getContainerStats: ReturnType<typeof vi.fn>;
    restartContainer: ReturnType<typeof vi.fn>;
    pullImage: ReturnType<typeof vi.fn>;
    getContainerLogs: ReturnType<typeof vi.fn>;
  };
} {
  const containers = [...(options.containers || [])];
  const details = { ...(options.containerDetails || {}) };
  const health = { ...(options.containerHealth || {}) };
  const stats = { ...(options.containerStats || {}) };
  const failSet = new Set(options.failOnContainers || []);

  const listContainers = vi.fn(async (): Promise<ContainerInfo[]> => {
    return containers;
  });

  const getContainerInfo = vi.fn(async (name: string): Promise<ContainerDetails> => {
    if (failSet.has(name)) {
      throw new Error(`Mock Docker: container ${name} not accessible`);
    }
    return details[name] || {
      state: 'running',
      running: true,
      ports: [],
      image: `test-image:latest`,
    };
  });

  const getContainerHealth = vi.fn(async (name: string): Promise<ContainerHealth> => {
    if (failSet.has(name)) {
      throw new Error(`Mock Docker: container ${name} not accessible`);
    }
    return health[name] || {
      state: 'running',
      status: 'Running',
      health: 'healthy',
      running: true,
    };
  });

  const getContainerStats = vi.fn(async (name: string): Promise<ContainerStats> => {
    if (failSet.has(name)) {
      throw new Error(`Mock Docker: container ${name} not accessible`);
    }
    return stats[name] || {
      cpuPercent: 5.0,
      memoryUsedMb: 128,
      memoryLimitMb: 512,
      networkRxMb: 1.0,
      networkTxMb: 0.5,
    };
  });

  const restartContainer = vi.fn(async (name: string): Promise<void> => {
    if (failSet.has(name)) {
      throw new Error(`Mock Docker: failed to restart container ${name}`);
    }
  });

  const pullImage = vi.fn(async (image: string): Promise<void> => {
    // Check if any failure container matches the image
    for (const name of failSet) {
      if (image.includes(name)) {
        throw new Error(`Mock Docker: failed to pull image ${image}`);
      }
    }
  });

  const getContainerLogs = vi.fn(async (name: string): Promise<string> => {
    if (failSet.has(name)) {
      throw new Error(`Mock Docker: container ${name} not found`);
    }
    return `[${new Date().toISOString()}] Container ${name} running normally\n`;
  });

  return {
    listContainers,
    getContainerInfo,
    getContainerHealth,
    getContainerStats,
    restartContainer,
    pullImage,
    getContainerLogs,
    failOnContainer: (name: string) => failSet.add(name),
    setHealthCheckResult: (name: string, healthy: boolean) => {
      health[name] = {
        state: healthy ? 'running' : 'unhealthy',
        status: healthy ? 'Running' : 'Container is unhealthy',
        health: healthy ? 'healthy' : 'unhealthy',
        running: true,
      };
    },
    addContainer: (info: ContainerInfo) => containers.push(info),
    calls: {
      listContainers,
      getContainerInfo,
      getContainerHealth,
      getContainerStats,
      restartContainer,
      pullImage,
      getContainerLogs,
    },
  };
}
