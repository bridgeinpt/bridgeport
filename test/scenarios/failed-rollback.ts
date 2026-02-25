/**
 * Failed rollback scenario.
 *
 * Creates a deployment history where the latest deployment failed
 * and was rolled back to the previous version.
 */
import { PrismaClient } from '@prisma/client';
import { createHealthyDeploymentScenario } from './healthy-deployment.js';
import { createTestDeployment } from '../factories/deployment.js';

export async function createFailedRollbackScenario(prisma: PrismaClient) {
  const base = await createHealthyDeploymentScenario(prisma);

  // A failed deployment attempt with v1.1.0
  const failedDeployment = await createTestDeployment(prisma, {
    serviceId: base.service.id,
    imageTag: 'v1.1.0',
    previousTag: 'v1.0.0',
    status: 'failed',
    logs: 'Error: Container health check failed after deployment',
    userId: base.user.id,
    triggeredBy: base.user.email,
  });

  // Automatic rollback to v1.0.0
  const rollbackDeployment = await createTestDeployment(prisma, {
    serviceId: base.service.id,
    imageTag: 'v1.0.0',
    previousTag: 'v1.1.0',
    status: 'success',
    logs: 'Rollback to v1.0.0 completed successfully',
    triggeredBy: 'auto-rollback',
  });

  return { ...base, failedDeployment, rollbackDeployment };
}
