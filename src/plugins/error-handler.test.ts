import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import errorHandlerPlugin from './error-handler.js';
import { ApiError } from '../lib/errors.js';

// Sentry capture should be observable; we don't want network calls.
vi.mock('../lib/sentry.js', () => ({
  captureException: vi.fn(),
}));
import { captureException } from '../lib/sentry.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  return app;
}

describe('error-handler plugin', () => {
  beforeEach(() => {
    vi.mocked(captureException).mockClear();
  });

  describe('setErrorHandler', () => {
    it('converts ApiError into the envelope with the right status', async () => {
      const app = await buildApp();
      app.get('/boom', async () => {
        throw new ApiError('NOT_FOUND', 'Service not found');
      });

      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
      expect(body.message).toBe('Service not found');
      expect(body.requestId).toBeDefined();
    });

    it('includes field and hint when ApiError carries them', async () => {
      const app = await buildApp();
      app.post('/v', async () => {
        throw new ApiError('VALIDATION_ERROR', 'Bad input', {
          field: 'password',
          hint: 'Must be at least 8 characters',
        });
      });

      const res = await app.inject({ method: 'POST', url: '/v', payload: {} });
      const body = res.json();
      expect(body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Bad input',
        field: 'password',
        hint: 'Must be at least 8 characters',
      });
    });

    it('converts ZodError to VALIDATION_ERROR with field path', async () => {
      const app = await buildApp();
      const schema = z.object({ email: z.string().email() });
      app.post('/z', async (req) => {
        // Throw the parse error directly.
        schema.parse(req.body);
        return { ok: true };
      });

      const res = await app.inject({
        method: 'POST',
        url: '/z',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.field).toBe('email');
    });

    it('hides 5xx error messages and captures to Sentry', async () => {
      const app = await buildApp();
      app.get('/crash', async () => {
        throw new Error('database password is hunter2');
      });

      const res = await app.inject({ method: 'GET', url: '/crash' });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.code).toBe('INTERNAL');
      expect(body.message).toBe('Internal Server Error');
      expect(body.message).not.toContain('hunter2');
      expect(captureException).toHaveBeenCalledTimes(1);
    });

    it('does not call Sentry for 4xx errors', async () => {
      const app = await buildApp();
      app.get('/nf', async () => {
        throw new ApiError('NOT_FOUND', 'gone');
      });

      await app.inject({ method: 'GET', url: '/nf' });
      expect(captureException).not.toHaveBeenCalled();
    });

    it('respects custom statusCode override on ApiError', async () => {
      const app = await buildApp();
      app.get('/x', async () => {
        throw new ApiError('VALIDATION_ERROR', 'Unprocessable', { statusCode: 422 });
      });

      const res = await app.inject({ method: 'GET', url: '/x' });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('masks ApiError messages on 5xx so internal detail does not leak', async () => {
      const app = await buildApp();
      app.get('/api-boom', async () => {
        throw new ApiError('INTERNAL', 'secret detail', { statusCode: 500 });
      });

      const res = await app.inject({ method: 'GET', url: '/api-boom' });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.code).toBe('INTERNAL');
      expect(body.message).toBe('Internal Server Error');
      expect(body.message).not.toContain('secret detail');
      // Original error is still captured to Sentry by the surrounding handler.
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('onSend reshaping', () => {
    it('reshapes legacy {error: "..."} 404 into the envelope', async () => {
      const app = await buildApp();
      app.get('/legacy', async (_req, reply) => {
        return reply.code(404).send({ error: 'Service not found' });
      });

      const res = await app.inject({ method: 'GET', url: '/legacy' });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
      expect(body.message).toBe('Service not found');
      expect(body.requestId).toBeDefined();
    });

    it('reshapes legacy 401 into UNAUTHORIZED', async () => {
      const app = await buildApp();
      app.get('/u', async (_req, reply) => {
        return reply.code(401).send({ error: 'No token' });
      });
      const res = await app.inject({ method: 'GET', url: '/u' });
      expect(res.json().code).toBe('UNAUTHORIZED');
    });

    it('reshapes legacy 403 into FORBIDDEN_SCOPE', async () => {
      const app = await buildApp();
      app.get('/f', async (_req, reply) => {
        return reply.code(403).send({ error: 'Forbidden' });
      });
      const res = await app.inject({ method: 'GET', url: '/f' });
      expect(res.json().code).toBe('FORBIDDEN_SCOPE');
    });

    it('reshapes legacy 409 into CONFLICT', async () => {
      const app = await buildApp();
      app.get('/c', async (_req, reply) => {
        return reply.code(409).send({ error: 'Duplicate' });
      });
      const res = await app.inject({ method: 'GET', url: '/c' });
      expect(res.json().code).toBe('CONFLICT');
    });

    it('reshapes legacy 429 into RATE_LIMITED', async () => {
      const app = await buildApp();
      app.get('/r', async (_req, reply) => {
        return reply.code(429).send({ error: 'Too many' });
      });
      const res = await app.inject({ method: 'GET', url: '/r' });
      expect(res.json().code).toBe('RATE_LIMITED');
    });

    it('hides 5xx messages even when the route sent a legacy body', async () => {
      const app = await buildApp();
      app.get('/s', async (_req, reply) => {
        return reply.code(500).send({ error: 'connection refused to internal-host' });
      });
      const res = await app.inject({ method: 'GET', url: '/s' });
      const body = res.json();
      expect(body.code).toBe('INTERNAL');
      expect(body.message).toBe('Internal Server Error');
      expect(body.message).not.toContain('internal-host');
    });

    it('is idempotent: bodies already in envelope shape are left alone (except requestId)', async () => {
      const app = await buildApp();
      app.get('/already', async (_req, reply) => {
        return reply
          .code(409)
          .send({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'replay' });
      });
      const res = await app.inject({ method: 'GET', url: '/already' });
      const body = res.json();
      expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(body.message).toBe('replay');
      expect(body.requestId).toBeDefined();
    });

    it('does not touch 2xx responses', async () => {
      const app = await buildApp();
      app.get('/ok', async () => ({ foo: 'bar' }));
      const res = await app.inject({ method: 'GET', url: '/ok' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ foo: 'bar' });
    });

    it('preserves legacy `details` array on validation errors', async () => {
      const app = await buildApp();
      app.get('/d', async (_req, reply) => {
        return reply.code(400).send({
          error: 'Invalid input',
          details: [{ path: ['email'], message: 'required' }],
        });
      });
      const res = await app.inject({ method: 'GET', url: '/d' });
      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details).toEqual([{ path: ['email'], message: 'required' }]);
    });

    it('drops legacy `details` on 5xx responses to avoid leaking debug info', async () => {
      const app = await buildApp();
      app.get('/sd', async (_req, reply) => {
        return reply.code(500).send({
          error: 'DB exploded',
          details: 'stack trace ...',
        });
      });
      const res = await app.inject({ method: 'GET', url: '/sd' });
      const body = res.json();
      expect(body.code).toBe('INTERNAL');
      expect(body.message).toBe('Internal Server Error');
      expect(body).not.toHaveProperty('details');
    });
  });
});
