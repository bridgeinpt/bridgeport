/**
 * Integration tests for importFromTerraform composePath handling (issue #200).
 *
 * "Never rewrite an operator-set composePath; opt-in auto-managed compose."
 *
 * These run against a real SQLite test DB (no SSH/Docker — the import path is
 * pure DB work). They call the importFromTerraform service directly, which uses
 * the singleton PrismaClient from src/lib/db.ts; the db helper guarantees that
 * singleton shares the same database file as `app.prisma`, so we can assert
 * against `app.prisma` for both deployment rows and audit log entries.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { cleanTestDb } from '../helpers/db.js';
import { createTestEnvironment, createTestServer } from '../factories/index.js';
import { importFromTerraform, type TerraformOutput } from '../../src/services/servers.js';

let app: TestApp;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanTestDb();
});

/** Set the per-environment autoManageCompose opt-in. */
async function setAutoManageCompose(environmentId: string, enabled: boolean) {
  await app.prisma.operationsSettings.create({
    data: { environmentId, autoManageCompose: enabled },
  });
}

/** Build a single-server, single-service terraform output. */
function tfOutput(opts: {
  serverName: string;
  serviceName: string;
  containerName: string;
  composePath?: string | null;
}): TerraformOutput {
  return {
    servers: [
      {
        name: opts.serverName,
        private_ip: '10.0.0.5',
        tags: ['web'],
        services: [
          {
            name: opts.serviceName,
            container_name: opts.containerName,
            image_name: 'registry.example.com/app',
            image_tag: 'v1.0',
            compose_path: opts.composePath ?? null,
          },
        ],
      },
    ],
  };
}

async function composePathAuditRows(environmentId: string) {
  return app.prisma.auditLog.findMany({
    where: { environmentId, action: 'service_deployment_compose_path_set' },
    orderBy: { createdAt: 'asc' },
  });
}

describe('importFromTerraform composePath handling (issue #200)', () => {
  it('does NOT clobber a non-null operator composePath on re-import (autoManage OFF)', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'tf-env-1' });
    await setAutoManageCompose(env.id, false);

    // First import seeds the server + service + deployment.
    await importFromTerraform(
      env.id,
      tfOutput({ serverName: 'srv-a', serviceName: 'web', containerName: 'web-prod', composePath: null })
    );

    // Operator manually points the deployment at a hand-maintained compose file.
    const dep = await app.prisma.serviceDeployment.findFirst({ where: { containerName: 'web-prod' } });
    expect(dep).not.toBeNull();
    const operatorPath = '/srv/operator/docker-compose.yml';
    await app.prisma.serviceDeployment.update({
      where: { id: dep!.id },
      data: { composePath: operatorPath },
    });

    // Re-import — terraform output even carries a DIFFERENT compose_path.
    await importFromTerraform(
      env.id,
      tfOutput({
        serverName: 'srv-a',
        serviceName: 'web',
        containerName: 'web-prod',
        composePath: '/terraform/managed/compose.yml',
      })
    );

    const after = await app.prisma.serviceDeployment.findUnique({ where: { id: dep!.id } });
    // The operator value survived the re-import untouched.
    expect(after!.composePath).toBe(operatorPath);
  });

  it('does NOT clobber a non-null operator composePath even when autoManage is ON', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'tf-env-2' });
    await setAutoManageCompose(env.id, true);

    await importFromTerraform(
      env.id,
      tfOutput({ serverName: 'srv-a', serviceName: 'web', containerName: 'web-prod', composePath: null })
    );
    const dep = await app.prisma.serviceDeployment.findFirst({ where: { containerName: 'web-prod' } });
    const operatorPath = '/srv/operator/docker-compose.yml';
    await app.prisma.serviceDeployment.update({
      where: { id: dep!.id },
      data: { composePath: operatorPath },
    });

    // Re-import with autoManage ON and a competing terraform compose_path.
    await importFromTerraform(
      env.id,
      tfOutput({
        serverName: 'srv-a',
        serviceName: 'web',
        containerName: 'web-prod',
        composePath: '/terraform/managed/compose.yml',
      })
    );

    const after = await app.prisma.serviceDeployment.findUnique({ where: { id: dep!.id } });
    expect(after!.composePath).toBe(operatorPath);
    // No audit entry, because no composePath change was performed.
    expect(await composePathAuditRows(env.id)).toHaveLength(0);
  });

  it('leaves a new deployment composePath null when autoManage is OFF (even if TF carries a path)', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'tf-env-3' });
    await setAutoManageCompose(env.id, false);

    await importFromTerraform(
      env.id,
      tfOutput({
        serverName: 'srv-a',
        serviceName: 'web',
        containerName: 'web-prod',
        composePath: '/terraform/managed/compose.yml',
      })
    );

    const dep = await app.prisma.serviceDeployment.findFirst({ where: { containerName: 'web-prod' } });
    expect(dep!.composePath).toBeNull();
    expect(await composePathAuditRows(env.id)).toHaveLength(0);
  });

  it('sets composePath on a NEW deployment and audit-logs source=terraform-import when autoManage is ON', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'tf-env-4' });
    await setAutoManageCompose(env.id, true);

    await importFromTerraform(
      env.id,
      tfOutput({
        serverName: 'srv-a',
        serviceName: 'web',
        containerName: 'web-prod',
        composePath: '/terraform/managed/compose.yml',
      })
    );

    const dep = await app.prisma.serviceDeployment.findFirst({ where: { containerName: 'web-prod' } });
    expect(dep!.composePath).toBe('/terraform/managed/compose.yml');

    const audits = await composePathAuditRows(env.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].resourceType).toBe('service_deployment');
    expect(audits[0].resourceId).toBe(dep!.id);
    const details = JSON.parse(audits[0].details!);
    expect(details.source).toBe('terraform-import');
    expect(details.composePath).toBe('/terraform/managed/compose.yml');
  });

  it('sets composePath on an EXISTING path-less deployment and audit-logs when autoManage is ON', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'tf-env-5' });
    const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv-a', hostname: '10.0.0.5' });
    await setAutoManageCompose(env.id, true);

    // Seed a path-less deployment first (no compose_path in TF), then re-import WITH a path.
    await importFromTerraform(
      env.id,
      tfOutput({ serverName: 'srv-a', serviceName: 'web', containerName: 'web-prod', composePath: null })
    );
    const before = await app.prisma.serviceDeployment.findFirst({ where: { containerName: 'web-prod' } });
    expect(before!.composePath).toBeNull();
    expect(before!.serverId).toBe(server.id);

    await importFromTerraform(
      env.id,
      tfOutput({
        serverName: 'srv-a',
        serviceName: 'web',
        containerName: 'web-prod',
        composePath: '/terraform/managed/compose.yml',
      })
    );

    const after = await app.prisma.serviceDeployment.findUnique({ where: { id: before!.id } });
    expect(after!.composePath).toBe('/terraform/managed/compose.yml');

    const audits = await composePathAuditRows(env.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].resourceId).toBe(before!.id);
    const details = JSON.parse(audits[0].details!);
    expect(details.source).toBe('terraform-import');
  });
});
