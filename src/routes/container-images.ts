import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import {
  createContainerImage,
  updateContainerImage,
  deleteContainerImage,
  getContainerImage,
  listContainerImages,
  linkServiceToContainerImage,
  getTagHistory,
  syncDigestsFromRegistry,
  listImageDigests,
  getImageDigest,
  listImageTags,
} from '../services/image-management.js';
import { buildDeploymentPlan, executePlan } from '../services/orchestration.js';
import { logAudit } from '../services/audit.js';
import { RegistryFactory } from '../lib/registry.js';
import { getRegistryCredentials } from '../services/registries.js';
import { extractRepoName, parseTagFilter, getBestTag, getDefaultTag } from '../lib/image-utils.js';

const createContainerImageSchema = z.object({
  name: z.string().min(1),
  imageName: z.string().min(1),
  tagFilter: z.string().min(1).default('latest'),
  registryConnectionId: z.string().nullable().optional(),
});

const updateContainerImageSchema = z.object({
  name: z.string().min(1).optional(),
  tagFilter: z.string().min(1).optional(),
  registryConnectionId: z.string().nullable().optional(),
  autoUpdate: z.boolean().optional(),
});

const deployImageSchema = z.object({
  imageTag: z.string().min(1).optional(),
  imageDigestId: z.string().optional(),
  autoRollback: z.boolean().default(true),
});

export async function containerImageRoutes(fastify: FastifyInstance): Promise<void> {
  // List container images for environment
  fastify.get(
    '/api/environments/:envId/container-images',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit, offset } = request.query as { limit?: string; offset?: string };
      const result = await listContainerImages(envId, {
        limit: limit ? parseInt(limit) : 25,
        offset: offset ? parseInt(offset) : 0,
      });

      const images = result.images.map((image) => {
        const { tagHistory, digests, ...rest } = image as typeof image & {
          tagHistory?: { deployedAt: Date }[];
          digests?: Array<{ id: string; manifestDigest: string; tags: string; discoveredAt: Date }>;
        };

        // Compute bestTag from latest digest
        const latestDigest = digests?.[0];
        let bestTag: string | null = null;
        if (latestDigest) {
          const tags = JSON.parse(latestDigest.tags) as string[];
          const patterns = parseTagFilter(rest.tagFilter);
          bestTag = getBestTag(tags, patterns);
        }

        return {
          ...rest,
          lastDeployedAt: tagHistory?.[0]?.deployedAt ?? null,
          latestDigest: latestDigest ? {
            id: latestDigest.id,
            manifestDigest: latestDigest.manifestDigest,
            tags: JSON.parse(latestDigest.tags),
            discoveredAt: latestDigest.discoveredAt,
          } : null,
          bestTag,
        };
      });

      return { images, total: result.total };
    }
  );

  // Create container image
  fastify.post(
    '/api/environments/:envId/container-images',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createContainerImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const image = await createContainerImage({
          ...body.data,
          environmentId: envId,
          registryConnectionId: body.data.registryConnectionId ?? undefined,
        });

        await logAudit({
          action: 'create',
          resourceType: 'container_image',
          resourceId: image.id,
          resourceName: image.name,
          details: { imageName: image.imageName, tagFilter: image.tagFilter },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { image };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'A container image for this image name already exists' });
        }
        throw error;
      }
    }
  );

  // Get container image
  fastify.get(
    '/api/container-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const image = await getContainerImage(id);

      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      // Convert BigInt size to Number for JSON serialization
      const { digests, ...rest } = image as typeof image & { digests?: Array<{ size: bigint | null; [key: string]: unknown }> };
      return {
        image: {
          ...rest,
          digests: digests?.map((d) => ({
            ...d,
            size: d.size !== null ? Number(d.size) : null,
          })),
        },
      };
    }
  );

  // Update container image
  fastify.patch(
    '/api/container-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateContainerImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.containerImage.findUnique({ where: { id } });
        const image = await updateContainerImage(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'container_image',
          resourceId: image.id,
          resourceName: image.name,
          details: { changes: body.data },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { image };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Container image not found' });
        }
        throw error;
      }
    }
  );

  // Delete container image
  fastify.delete(
    '/api/container-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const image = await prisma.containerImage.findUnique({ where: { id } });
        await deleteContainerImage(id);

        if (image) {
          await logAudit({
            action: 'delete',
            resourceType: 'container_image',
            resourceId: id,
            resourceName: image.name,
            userId: request.authUser!.id,
            environmentId: image.environmentId,
          });
        }

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Container image not found' });
        }
        // Handle delete restriction error
        if (error instanceof Error && error.message.includes('Cannot delete container image')) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // Deploy container image to all linked services
  fastify.post(
    '/api/container-images/:id/deploy',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deployImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Must provide either imageTag or imageDigestId
      if (!body.data.imageTag && !body.data.imageDigestId) {
        return reply.code(400).send({ error: 'Either imageTag or imageDigestId must be provided' });
      }

      const image = await getContainerImage(id);
      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      if (image.services.length === 0) {
        return reply.code(400).send({ error: 'No services linked to this image' });
      }

      // Resolve tag from digest if needed
      let imageTag = body.data.imageTag;
      if (!imageTag && body.data.imageDigestId) {
        const digest = await getImageDigest(body.data.imageDigestId);
        if (!digest) {
          return reply.code(404).send({ error: 'Image digest not found' });
        }
        const digestTags = JSON.parse(digest.tags) as string[];
        const patterns = parseTagFilter(image.tagFilter);
        imageTag = getBestTag(digestTags, patterns) || digestTags[0] || getDefaultTag(image.tagFilter);
      }

      try {
        // Build and start the deployment plan
        const plan = await buildDeploymentPlan({
          environmentId: image.environmentId,
          containerImageId: id,
          imageTag: imageTag!,
          triggerType: 'manual',
          triggeredBy: request.authUser!.email,
          userId: request.authUser!.id,
          autoRollback: body.data.autoRollback,
        });

        await logAudit({
          action: 'deploy',
          resourceType: 'container_image',
          resourceId: id,
          resourceName: image.name,
          details: {
            imageTag,
            imageDigestId: body.data.imageDigestId,
            planId: plan.id,
            serviceCount: image.services.length,
          },
          userId: request.authUser!.id,
          environmentId: image.environmentId,
        });

        // Execute plan asynchronously
        executePlan(plan.id).catch((err) => {
          console.error(`[ContainerImage] Plan ${plan.id} execution failed:`, err);
        });

        return { plan };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Deployment failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Get tag history for container image
  fastify.get(
    '/api/container-images/:id/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const image = await prisma.containerImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      const history = await getTagHistory(id, limit ? parseInt(limit) : 20);
      return { history };
    }
  );

  // List tags from registry for a container image (browse mode - unfiltered)
  fastify.get(
    '/api/container-images/:id/tags',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await listImageTags(id);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list tags';
        if (message.includes('not found')) {
          return reply.code(404).send({ error: message });
        }
        if (message.includes('No registry') || message.includes('Could not get')) {
          return reply.code(400).send({ error: message });
        }
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Check for updates from registry (triggers digest sync)
  fastify.post(
    '/api/container-images/:id/check-updates',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const image = await prisma.containerImage.findUnique({
        where: { id },
        include: { registryConnection: true },
      });

      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      if (!image.registryConnectionId) {
        return reply.code(400).send({ error: 'No registry connection configured for this image' });
      }

      const creds = await getRegistryCredentials(image.registryConnectionId);
      if (!creds) {
        return reply.code(400).send({ error: 'Could not get registry credentials' });
      }

      try {
        const client = RegistryFactory.create(creds);
        const repoName = extractRepoName(image.imageName, creds.repositoryPrefix);
        const allTags = await client.listTags(repoName);

        const result = await syncDigestsFromRegistry(image.id, allTags);

        // Get the newest digest for display
        const { digests } = await listImageDigests(image.id, { limit: 1 });
        const newest = digests[0];

        return {
          hasUpdate: result.hasUpdate,
          tagFilter: image.tagFilter,
          newestDigest: newest ? {
            id: newest.id,
            manifestDigest: newest.manifestDigest,
            bestTag: newest.bestTag,
            tags: JSON.parse(newest.tags),
            discoveredAt: newest.discoveredAt,
          } : null,
          newDigests: result.newDigests,
          updatedDigests: result.updatedDigests,
          lastCheckedAt: new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check for updates';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // List digests for a container image (paginated)
  fastify.get(
    '/api/container-images/:id/digests',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit, offset } = request.query as { limit?: string; offset?: string };

      const image = await prisma.containerImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      const result = await listImageDigests(id, {
        limit: limit ? parseInt(limit) : 20,
        offset: offset ? parseInt(offset) : 0,
      });

      return result;
    }
  );

  // Get a single digest detail
  fastify.get(
    '/api/container-images/:id/digests/:digestId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { digestId } = request.params as { id: string; digestId: string };

      const digest = await getImageDigest(digestId);
      if (!digest) {
        return reply.code(404).send({ error: 'Image digest not found' });
      }

      return { digest };
    }
  );

  // Link service to container image
  fastify.post(
    '/api/container-images/:id/link/:serviceId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id, serviceId } = request.params as { id: string; serviceId: string };

      const image = await prisma.containerImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      const service = await prisma.service.findUnique({
        where: { id: serviceId },
        include: { server: true },
      });
      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Verify service is in same environment
      if (service.server.environmentId !== image.environmentId) {
        return reply.code(400).send({ error: 'Service must be in the same environment as the container image' });
      }

      const updatedService = await linkServiceToContainerImage(id, serviceId);

      await logAudit({
        action: 'update',
        resourceType: 'container_image',
        resourceId: id,
        resourceName: image.name,
        details: { linkedService: service.name, serviceId },
        userId: request.authUser!.id,
        environmentId: image.environmentId,
      });

      return { service: updatedService };
    }
  );

  // Get services that could be re-linked (different containerImageId)
  fastify.get(
    '/api/container-images/:id/linkable-services',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const image = await prisma.containerImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Container image not found' });
      }

      // Find services in same environment that are linked to a different container image
      const services = await prisma.service.findMany({
        where: {
          server: {
            environmentId: image.environmentId,
          },
          containerImageId: {
            not: id,
          },
        },
        include: {
          server: true,
          containerImage: {
            select: { id: true, name: true, imageName: true },
          },
        },
      });

      return { services };
    }
  );
}
