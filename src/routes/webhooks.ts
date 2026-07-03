import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/db.js';
import { deployService, deployServiceTemplate } from '../services/deploy.js';
import { buildDeploymentPlan, executePlan } from '../services/orchestration.js';
import { logAudit } from '../services/audit.js';
import { DEPLOYMENT_STATUS } from '../lib/constants.js';
import { validateBody, findOrNotFound, getErrorMessage } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

// The raw request bytes, stashed by the JSON content-type parser in server.ts.
// Signature-verified webhook endpoints HMAC these exact bytes rather than a
// re-serialized object (key order / whitespace would otherwise break the HMAC).
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

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

// Constant-time string compare that never throws. crypto.timingSafeEqual
// raises a RangeError when the two buffers differ in length (e.g. an attacker
// sends a short/garbage signature), so we length-check first and only then
// compare — returning false rather than surfacing an uncaught 500.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Simple webhook secret verification. `payload` MUST be the raw request body
// bytes as received (request.rawBody), not a re-serialized object — HMAC is
// only meaningful over the exact bytes the sender signed.
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return safeEqual(signature, expectedSignature);
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // CI/CD deployment webhook
  fastify.post('/api/webhooks/deploy', {
    schema: routeSchema({
      tags: ['services'],
      summary: 'CI/CD webhook: deploy a service by name or ID',
      body: deployWebhookSchema,
      errors: [400, 401, 404, 500],
    }),
  }, async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // Fail closed: this endpoint triggers real deployments, so it must be
    // authenticated. If no secret is configured the endpoint is DISABLED
    // (returns 401) rather than left open to unauthenticated callers.
    if (!webhookSecret) {
      return reply.code(401).send({
        error: 'Webhook authentication is not configured. Set WEBHOOK_SECRET to enable this endpoint.',
      });
    }
    if (!signature) {
      return reply.code(401).send({ error: 'Missing signature' });
    }
    // HMAC over the exact received bytes (request.rawBody), not a re-serialized
    // object — see the JSON content-type parser in server.ts.
    if (!verifyWebhookSignature(request.rawBody ?? '', signature, webhookSecret)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const body = validateBody(deployWebhookSchema, request, reply);
    if (!body) return;

    // Find environment
    const environment = await findOrNotFound(
      prisma.environment.findUnique({ where: { name: body.environment } }),
      'Environment',
      reply
    );
    if (!environment) return;

    // Find service by name in the environment (Service is env-scoped now).
    const service = await findOrNotFound(
      prisma.service.findFirst({
        where: {
          OR: [
            { id: body.service },
            { name: body.service },
          ],
          environmentId: environment.id,
        },
        include: { serviceDeployments: { select: { id: true } } },
      }),
      'Service',
      reply
    );
    if (!service) return;

    try {
      // Fan out: deploy this template's strategy (sequential | parallel) across all its deployments.
      const outcome = await deployServiceTemplate(
        service.id,
        'webhook',
        null,
        {
          imageTag: body.imageTag,
          generateArtifacts: body.generateArtifacts,
        }
      );

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { source: 'custom-webhook', imageTag: body.imageTag, deploymentCount: outcome.results.length, halted: outcome.halted },
        environmentId: environment.id,
      });

      // Treat template-level error (e.g. zero deployments) as a 400 — the
      // caller didn't trigger any actual deploy, so reporting success=true would
      // mislead CI/release automation.
      if (outcome.error) {
        return reply.code(400).send({
          success: false,
          error: outcome.error,
          deploymentCount: 0,
          halted: outcome.halted,
        });
      }

      const firstFailure = outcome.results.find((r) => !r.result || r.result.deployment.status !== DEPLOYMENT_STATUS.SUCCESS);
      return {
        success: !firstFailure,
        deploymentCount: outcome.results.length,
        halted: outcome.halted,
        results: outcome.results.map((r) => ({ serviceDeploymentId: r.serviceDeploymentId, status: r.result?.deployment.status ?? 'failed' })),
      };
    } catch (error) {
      const message = getErrorMessage(error, 'Deployment failed');

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { source: 'custom-webhook', imageTag: body.imageTag },
        success: false,
        error: message,
        environmentId: environment.id,
      });

      return reply.code(500).send({ error: message });
    }
  });

  // GitHub Actions compatible webhook
  fastify.post('/api/webhooks/github', {
    schema: routeSchema({
      tags: ['services'],
      summary: 'GitHub Actions webhook: deploy on package published events',
      errors: [400, 401],
    }),
  }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    // Fail closed. Previously verification ran only `if (webhookSecret && signature)`,
    // so omitting the signature header skipped it entirely — an auth bypass. Now the
    // endpoint is disabled unless a secret is configured, and the signature is required.
    if (!webhookSecret) {
      return reply.code(401).send({
        error: 'GitHub webhook authentication is not configured. Set GITHUB_WEBHOOK_SECRET to enable this endpoint.',
      });
    }
    if (!signature) {
      return reply.code(401).send({ error: 'Missing signature' });
    }
    // HMAC over the exact received bytes (GitHub signs the raw payload).
    const expectedSig = 'sha256=' + crypto
      .createHmac('sha256', webhookSecret)
      .update(request.rawBody ?? '')
      .digest('hex');
    if (!safeEqual(signature, expectedSig)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const event = request.headers['x-github-event'];
    const payload = request.body as Record<string, unknown>;

    // Handle package published event (container registry)
    if (event === 'package' && payload.action === 'published') {
      const packageData = payload.package as
        | { name?: string; package_version?: { version?: string } }
        | undefined;
      const packageName = packageData?.name;
      const version = packageData?.package_version?.version;

      // Require a concrete package name and a well-formed image tag. An empty
      // name would `contains: ''`-match every image in every environment (mass
      // redeploy), and the version flows into the image reference for the pull.
      if (!packageName || !version || !/^[A-Za-z0-9._:/-]+$/.test(version)) {
        return reply.code(400).send({ error: 'Invalid or incomplete package payload' });
      }

      // Find matching services and deploy
      const services = await prisma.service.findMany({
        where: {
          containerImage: {
            imageName: {
              contains: packageName,
            },
          },
        },
      });

      const results = [];
      for (const service of services) {
        try {
          // Fan-out across all deployments using the template's configured strategy.
          const outcome = await deployServiceTemplate(
            service.id,
            'github-webhook',
            null,
            { imageTag: version }
          );

          const serviceRow = await prisma.service.findUnique({
            where: { id: service.id },
            select: { environmentId: true },
          });

          await logAudit({
            action: 'webhook_deploy',
            resourceType: 'service',
            resourceId: service.id,
            resourceName: service.name,
            details: { source: 'github-webhook', packageName, imageTag: version, deploymentCount: outcome.results.length, halted: outcome.halted },
            environmentId: serviceRow?.environmentId,
          });

          const anyFailed = outcome.error
            ? true
            : outcome.results.some((r) => !r.result || r.result.deployment.status !== DEPLOYMENT_STATUS.SUCCESS);
          results.push({
            service: service.name,
            status: anyFailed ? DEPLOYMENT_STATUS.FAILED : DEPLOYMENT_STATUS.SUCCESS,
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
  fastify.post('/api/webhooks/deploy-image', {
    schema: routeSchema({
      tags: ['services'],
      summary: 'Webhook: deploy all services for a ContainerImage (respects autoUpdate)',
      body: deployImageWebhookSchema,
      errors: [400, 401, 404, 500],
    }),
  }, async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // Fail closed: this endpoint triggers real deployments, so it must be
    // authenticated. If no secret is configured the endpoint is DISABLED
    // (returns 401) rather than left open to unauthenticated callers.
    if (!webhookSecret) {
      return reply.code(401).send({
        error: 'Webhook authentication is not configured. Set WEBHOOK_SECRET to enable this endpoint.',
      });
    }
    if (!signature) {
      return reply.code(401).send({ error: 'Missing signature' });
    }
    // HMAC over the exact received bytes (request.rawBody), not a re-serialized
    // object — see the JSON content-type parser in server.ts.
    if (!verifyWebhookSignature(request.rawBody ?? '', signature, webhookSecret)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const body = validateBody(deployImageWebhookSchema, request, reply);
    if (!body) return;

    // Find environment
    const environment = await findOrNotFound(
      prisma.environment.findUnique({ where: { name: body.environment } }),
      'Environment',
      reply
    );
    if (!environment) return;

    // Find container image by imageName in the environment
    // autoUpdate is now on ContainerImage, not Service
    const containerImage = await prisma.containerImage.findFirst({
      where: {
        imageName: body.imageName,
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
          imageName: body.imageName,
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
        imageTag: body.imageTag,
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
          imageTag: body.imageTag,
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
      const message = getErrorMessage(error, 'Deployment failed');

      await logAudit({
        action: 'webhook_deploy',
        resourceType: 'container_image',
        resourceId: containerImage.id,
        resourceName: containerImage.name,
        details: { source: 'deploy-image-webhook', imageTag: body.imageTag },
        success: false,
        error: message,
        environmentId: environment.id,
      });

      return reply.code(500).send({ error: message });
    }
  });
}
