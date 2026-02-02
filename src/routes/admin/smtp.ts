import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../../plugins/authorize.js';
import {
  getSmtpConfig,
  saveSmtpConfig,
  testSmtpConnection,
  sendTestEmail,
} from '../../services/email.js';
import { logAudit } from '../../services/audit.js';

const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
  fromAddress: z.string().email(),
  fromName: z.string().optional(),
  enabled: z.boolean().optional(),
});

const testEmailSchema = z.object({
  to: z.string().email(),
});

export async function smtpRoutes(fastify: FastifyInstance): Promise<void> {
  // Get SMTP configuration
  fastify.get(
    '/api/admin/smtp',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const config = await getSmtpConfig();
      return { config };
    }
  );

  // Save SMTP configuration
  fastify.put(
    '/api/admin/smtp',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = smtpConfigSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const config = await saveSmtpConfig(body.data);

      await logAudit({
        action: 'update',
        resourceType: 'smtp_config',
        resourceId: config.id,
        resourceName: 'SMTP Configuration',
        details: { host: config.host, enabled: config.enabled },
        userId: request.authUser!.id,
      });

      return { config };
    }
  );

  // Test SMTP connection
  fastify.post(
    '/api/admin/smtp/test',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = request.body as { to?: string } | undefined;

      // If email address provided, send test email
      if (body?.to) {
        const parsed = testEmailSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid email address' });
        }

        const result = await sendTestEmail(parsed.data.to);
        if (!result.success) {
          return reply.code(400).send({ error: result.error || 'Failed to send test email' });
        }

        return { success: true, message: `Test email sent to ${parsed.data.to}` };
      }

      // Otherwise just test connection
      const result = await testSmtpConnection();
      if (!result.success) {
        return reply.code(400).send({ error: result.error || 'Connection test failed' });
      }

      return { success: true, message: 'SMTP connection successful' };
    }
  );
}
