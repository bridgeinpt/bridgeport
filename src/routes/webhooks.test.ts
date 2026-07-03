import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

const WEBHOOK_SECRET = 'test-webhook-secret';
const GITHUB_SECRET = 'test-github-secret';

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('webhook routes', () => {
  let app: TestApp;
  let adminToken: string;
  let envId: string;
  const priorWebhookSecret = process.env.WEBHOOK_SECRET;
  const priorGithubSecret = process.env.GITHUB_WEBHOOK_SECRET;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@webhooks.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });

    const env = await createTestEnvironment(app.prisma, { name: 'wh-env' });
    envId = env.id;
    await createTestContainerImage(app.prisma, {
      environmentId: envId,
      imageName: 'registry.example.com/webhook-app',
    });
  });

  afterAll(async () => {
    // Restore process.env so we don't leak secrets into sibling test files.
    if (priorWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = priorWebhookSecret;
    if (priorGithubSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = priorGithubSecret;
    await app.close();
  });

  describe('POST /api/webhooks/deploy — fail-closed authentication', () => {
    it('rejects with 401 when no WEBHOOK_SECRET is configured (endpoint disabled)', async () => {
      delete process.env.WEBHOOK_SECRET;
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ service: 'x', environment: 'wh-env' }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects with 401 when the secret is set but the signature header is missing', async () => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ service: 'x', environment: 'wh-env' }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects with 401 on an invalid signature', async () => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
      const body = JSON.stringify({ service: 'x', environment: 'wh-env' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 'deadbeef' },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });

    it('passes authentication with a valid signature over the raw body', async () => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
      // Unknown service → business logic returns 404, but crucially NOT 401:
      // this proves the signature verified and the request reached the handler.
      const body = JSON.stringify({ service: 'does-not-exist', environment: 'wh-env' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': sign(WEBHOOK_SECRET, body),
        },
        payload: body,
      });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/webhooks/github — signature-bypass fixed', () => {
    it('rejects with 401 when the signature header is omitted even though the secret is set', async () => {
      // Regression guard for the "verify only if header present" bypass.
      process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: { 'content-type': 'application/json', 'x-github-event': 'package' },
        payload: JSON.stringify({ action: 'published', package: { name: '', package_version: { version: 'x' } } }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects with 401 when GITHUB_WEBHOOK_SECRET is unset (endpoint disabled)', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: { 'content-type': 'application/json', 'x-github-event': 'package' },
        payload: JSON.stringify({ action: 'published', package: { name: 'x', package_version: { version: 'v1' } } }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an empty package name with 400 even with a valid signature (no mass match)', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
      const body = JSON.stringify({ action: 'published', package: { name: '', package_version: { version: 'v1' } } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'package',
          'x-hub-signature-256': 'sha256=' + sign(GITHUB_SECRET, body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an image tag with shell metacharacters (400) with a valid signature', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
      const body = JSON.stringify({
        action: 'published',
        package: { name: 'webhook-app', package_version: { version: 'v1; touch /tmp/pwned' } },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'package',
          'x-hub-signature-256': 'sha256=' + sign(GITHUB_SECRET, body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
