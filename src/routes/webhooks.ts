import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/db.js';
import { deployService } from '../services/deploy.js';
import { buildDeploymentPlan, executePlan } from '../services/orchestration.js';
import { logAudit } from '../services/audit.js';
import { DEPLOYMENT_STATUS } from '../lib/constants.js';

const deployWebhookSchema = z.object({
  service: z.string().min(1), // Service name or ID
  environment: z.string().min(1), // Environment name
  imageTag: z.string().optional(),
  generateArtifacts: z.boolean().default(false),
});

const deployImageWebhookSchema = z.object({
  imageName: z.string().min(1), // Full image name
  environment: z.string().min(1), // Environment name
  imageTag: z.string().min(1),
});

// Simple webhook secret verification
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // CI/CD deployment webhook
  fastify.post('/api/webhooks/deploy', async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // Verify signature if secret is configured
    if (webhookSecret) {
      if (!signature) {
        return reply.code(401).send({ error: 'Missing signature' });
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    }

    const body = deployWebhookSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
    }

    // Find environment
    const environment = await prisma.environment.findUnique({
      where: { name: body.data.environment },
    });

    if (!environment) {
      return reply.code(404).send({ error: 'Environment not found' });
    }

    // Find service by name in the environment
    const service = await prisma.service.findFirst({
      where: {
        OR: [
          { id: body.data.service },
          { name: body.data.service },
        ],
        server: {
          environmentId: environment.id,
        },
      },
    });

    if (!service) {
      return reply.code(404).send({ error: 'Service not found' });
    }

    try {
      const result = await deployService(
        service.id,
        'webhook',
        null,
        {
          imageTag: body.data.imageTag,
          generateArtifacts: body.data.generateArtifacts,
        }
      );

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { source: 'custom-webhook', imageTag: body.data.imageTag, deploymentId: result.deployment.id },
        environmentId: environment.id,
      });

      return {
        success: result.deployment.status === DEPLOYMENT_STATUS.SUCCESS,
        deploymentId: result.deployment.id,
        status: result.deployment.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { source: 'custom-webhook', imageTag: body.data.imageTag },
        success: false,
        error: message,
        environmentId: environment.id,
      });

      return reply.code(500).send({ error: message });
    }
  });

  // GitHub Actions compatible webhook
  fastify.post('/api/webhooks/github', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    // Verify GitHub signature
    if (webhookSecret && signature) {
      const rawBody = JSON.stringify(request.body);
      const expectedSig = 'sha256=' + crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    }

    const event = request.headers['x-github-event'];
    const payload = request.body as Record<string, unknown>;

    // Handle package published event (container registry)
    if (event === 'package' && payload.action === 'published') {
      const packageData = payload.package as {
        name: string;
        package_version: { version: string };
      };

      // Find matching services and deploy
      const services = await prisma.service.findMany({
        where: {
          containerImage: {
            imageName: {
              contains: packageData.name,
            },
          },
        },
      });

      const results = [];
      for (const service of services) {
        try {
          const result = await deployService(
            service.id,
            'github-webhook',
            null,
            {
              imageTag: packageData.package_version.version,
            }
          );

          const serviceWithServer = await prisma.service.findUnique({
            where: { id: service.id },
            include: { server: true },
          });

          await logAudit({
            action: 'webhook_deploy',
            resourceType: 'service',
            resourceId: service.id,
            resourceName: service.name,
            details: { source: 'github-webhook', packageName: packageData.name, imageTag: packageData.package_version.version },
            environmentId: serviceWithServer?.server.environmentId,
          });

          results.push({
            service: service.name,
            status: result.deployment.status,
          });
        } catch {
          results.push({
            service: service.name,
            status: DEPLOYMENT_STATUS.FAILED,
          });
        }
      }

      return { processed: results.length, results };
    }

    return { message: 'Event ignored' };
  });

  // Deploy all services for a ContainerImage (respects autoUpdate flag)
  fastify.post('/api/webhooks/deploy-image', async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // Verify signature if secret is configured
    if (webhookSecret) {
      if (!signature) {
        return reply.code(401).send({ error: 'Missing signature' });
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    }

    const body = deployImageWebhookSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
    }

    // Find environment
    const environment = await prisma.environment.findUnique({
      where: { name: body.data.environment },
    });

    if (!environment) {
      return reply.code(404).send({ error: 'Environment not found' });
    }

    // Find container image by imageName in the environment
    // autoUpdate is now on ContainerImage, not Service
    const containerImage = await prisma.containerImage.findFirst({
      where: {
        imageName: body.data.imageName,
        environmentId: environment.id,
        autoUpdate: true,  // Only deploy if autoUpdate is enabled on the image
      },
      include: {
        services: true,
      },
    });

    if (!containerImage) {
      // Check if the image exists but doesn't have autoUpdate enabled
      const imageExists = await prisma.containerImage.findFirst({
        where: {
          imageName: body.data.imageName,
          environmentId: environment.id,
        },
      });

      if (imageExists) {
        return reply.code(400).send({
          error: 'Container image does not have autoUpdate enabled',
          hint: 'Enable autoUpdate on the container image to deploy via this webhook',
        });
      }

      return reply.code(404).send({ error: 'Container image not found' });
    }

    if (containerImage.services.length === 0) {
      return reply.code(400).send({
        error: 'No services linked to this container image',
        hint: 'Link services to the container image before deploying',
      });
    }

    try {
      // Build deployment plan for all linked services
      const plan = await buildDeploymentPlan({
        environmentId: environment.id,
        containerImageId: containerImage.id,
        imageTag: body.data.imageTag,
        triggerType: 'webhook',
        triggeredBy: 'webhook',
      });

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'container_image',
        resourceId: containerImage.id,
        resourceName: containerImage.name,
        details: {
          source: 'deploy-image-webhook',
          imageTag: body.data.imageTag,
          planId: plan.id,
          serviceCount: containerImage.services.length,
        },
        environmentId: environment.id,
      });

      // Execute plan asynchronously
      executePlan(plan.id).catch((err) => {
        console.error(`[Webhook] Plan ${plan.id} execution failed:`, err);
      });

      return {
        success: true,
        planId: plan.id,
        serviceCount: containerImage.services.length,
        services: containerImage.services.map((s: { name: string }) => s.name),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'container_image',
        resourceId: containerImage.id,
        resourceName: containerImage.name,
        details: { source: 'deploy-image-webhook', imageTag: body.data.imageTag },
        success: false,
        error: message,
        environmentId: environment.id,
      });

      return reply.code(500).send({ error: message });
    }
  });
}
