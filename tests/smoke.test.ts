/**
 * Smoke test to verify the test infrastructure works.
 *
 * This test validates:
 * - Database helpers (setup, teardown, clean)
 * - All factory functions
 * - Mock objects
 * - Auth token generation
 * - SSE parser
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupTestDb, teardownTestDb, cleanTestDb, getTestPrisma } from './helpers/db.js';
import { generateTestToken } from './helpers/auth.js';
import { parseSSEResponse } from './helpers/sse.js';
import {
  createTestUser,
  createTestEnvironment,
  createTestServer,
  createTestContainerImage,
  createTestService,
  createTestDeployment,
  createTestDatabase,
  createTestNotificationType,
  createTestNotification,
} from './factories/index.js';
import { createMockDocker } from './mocks/docker.js';
import { createMockSSH } from './mocks/ssh.js';
import { createMockRegistry } from './mocks/registry.js';
import { createMockSmtp } from './mocks/smtp.js';
import { createMockSlack } from './mocks/slack.js';
import { createMockSpaces } from './mocks/spaces.js';

describe('test infrastructure smoke test', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('database helpers', () => {
    it('should set up and connect to test database', () => {
      expect(prisma).toBeDefined();
      expect(getTestPrisma()).toBe(prisma);
    });

    it('should clean the database between tests', async () => {
      await createTestEnvironment(prisma, { name: 'temp-env' });
      const envs = await prisma.environment.findMany();
      expect(envs.length).toBeGreaterThan(0);

      await cleanTestDb();

      const envsAfter = await prisma.environment.findMany();
      expect(envsAfter).toHaveLength(0);
    });
  });

  describe('factory functions', () => {
    it('should create a user', async () => {
      const user = await createTestUser(prisma, {
        email: 'factory-test@test.com',
        role: 'admin',
      });
      expect(user.id).toBeDefined();
      expect(user.email).toBe('factory-test@test.com');
      expect(user.role).toBe('admin');
      expect(user.password).toBeDefined();
    });

    it('should create a full entity chain', async () => {
      const env = await createTestEnvironment(prisma);
      expect(env.id).toBeDefined();

      const server = await createTestServer(prisma, {
        environmentId: env.id,
      });
      expect(server.environmentId).toBe(env.id);

      const image = await createTestContainerImage(prisma, {
        environmentId: env.id,
      });
      expect(image.environmentId).toBe(env.id);

      const service = await createTestService(prisma, {
        serverId: server.id,
        containerImageId: image.id,
      });
      expect(service.serverId).toBe(server.id);
      expect(service.containerImageId).toBe(image.id);

      const deployment = await createTestDeployment(prisma, {
        serviceId: service.id,
      });
      expect(deployment.serviceId).toBe(service.id);
      expect(deployment.status).toBe('success');
    });

    it('should create a database', async () => {
      const env = await createTestEnvironment(prisma);
      const db = await createTestDatabase(prisma, {
        environmentId: env.id,
        type: 'postgres',
      });
      expect(db.id).toBeDefined();
      expect(db.type).toBe('postgres');
    });

    it('should create notification type and notification', async () => {
      const user = await createTestUser(prisma);
      const notifType = await createTestNotificationType(prisma, {
        code: 'test.smoke',
        severity: 'warning',
      });
      expect(notifType.severity).toBe('warning');

      const notif = await createTestNotification(prisma, {
        typeId: notifType.id,
        userId: user.id,
      });
      expect(notif.userId).toBe(user.id);
    });

    afterAll(async () => {
      await cleanTestDb();
    });
  });

  describe('mock objects', () => {
    it('should create a mock Docker client', async () => {
      const docker = createMockDocker({
        containers: [
          { id: 'abc123', name: 'test', image: 'nginx:latest', status: 'Up', state: 'running' },
        ],
      });

      const containers = await docker.listContainers();
      expect(containers).toHaveLength(1);
      expect(containers[0].name).toBe('test');

      const health = await docker.getContainerHealth('test');
      expect(health.running).toBe(true);

      docker.failOnContainer('test');
      await expect(docker.getContainerHealth('test')).rejects.toThrow();
    });

    it('should create a mock SSH client', async () => {
      const ssh = createMockSSH({
        commandResponses: {
          'docker ps': { stdout: 'CONTAINER\ttest', code: 0 },
        },
      });

      await ssh.connect();
      const result = await ssh.exec('docker ps -a');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('test');
      expect(ssh.executedCommands).toContain('docker ps -a');
    });

    it('should create a mock registry client', async () => {
      const registry = createMockRegistry({
        repositories: {
          myapp: [
            { tag: 'v1.0.0', digest: 'sha256:abc', size: 1000, updatedAt: '2024-01-01T00:00:00Z' },
          ],
        },
      });

      const repos = await registry.listRepositories();
      expect(repos).toHaveLength(1);

      const tags = await registry.listTags('myapp');
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('v1.0.0');
    });

    it('should create a mock SMTP transport', async () => {
      const smtp = createMockSmtp();
      await smtp.sendMail({
        from: 'test@test.com',
        to: 'user@test.com',
        subject: 'Test',
        html: '<p>Hello</p>',
      });
      expect(smtp.sentEmails).toHaveLength(1);
      expect(smtp.sentEmails[0].subject).toBe('Test');
    });

    it('should create a mock Slack client', async () => {
      const slack = createMockSlack();
      await slack.send('https://hooks.slack.com/test', { text: 'Hello' });
      expect(slack.sentMessages).toHaveLength(1);
      expect(slack.sentMessages[0].payload.text).toBe('Hello');
    });

    it('should create a mock Spaces client', () => {
      const spaces = createMockSpaces();
      spaces.addObject('my-bucket', {
        key: 'backups/test.sql',
        body: Buffer.from('SQL dump content'),
      });
      expect(spaces.objects.size).toBe(1);
    });
  });

  describe('auth helpers', () => {
    it('should generate a valid JWT token', async () => {
      const token = await generateTestToken({
        id: 'user-123',
        email: 'test@test.com',
      });
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('SSE helpers', () => {
    it('should parse SSE response', () => {
      const raw = [
        'id: 1',
        'event: deployment:step',
        'data: {"stepId":"abc","status":"running"}',
        '',
        'id: 2',
        'event: deployment:complete',
        'data: {"success":true}',
        '',
      ].join('\n');

      const events = parseSSEResponse(raw);
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe('deployment:step');
      expect(events[0].id).toBe('1');
      expect(JSON.parse(events[0].data)).toEqual({ stepId: 'abc', status: 'running' });
      expect(events[1].event).toBe('deployment:complete');
    });
  });
});
