import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../../tests/helpers/app.js';
import { createTestUser } from '../../../tests/factories/user.js';
import { generateTestToken } from '../../../tests/helpers/auth.js';
import { ALL_TOOLS } from '../../mcp/tools.js';
import { ALL_RESOURCES } from '../../mcp/resources.js';

describe('admin mcp routes', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@mcp.test', role: 'admin' });
    const operator = await createTestUser(app.prisma, { email: 'operator@mcp.test', role: 'operator' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@mcp.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/mcp', () => {
    it('returns the MCP inventory + enabled flag for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/mcp',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Status / config shape.
      expect(typeof body.enabled).toBe('boolean');
      expect(body.endpointPath).toBe('/mcp');
      expect(body.dnsRebindingProtection).toBeDefined();
      expect(typeof body.dnsRebindingProtection.configured).toBe('boolean');
      expect(Array.isArray(body.dnsRebindingProtection.allowedHosts)).toBe(true);

      // Inventory mirrors the registries (works regardless of MCP_ENABLED).
      expect(Array.isArray(body.tools)).toBe(true);
      expect(Array.isArray(body.resources)).toBe(true);
      expect(body.tools.length).toBe(ALL_TOOLS.length);
      expect(body.resources.length).toBe(ALL_RESOURCES.length);

      // Counts are internally consistent.
      expect(body.counts.tools).toBe(body.tools.length);
      expect(body.counts.resources).toBe(body.resources.length);
      expect(body.counts.readTools + body.counts.writeTools).toBe(body.counts.tools);
      expect(body.counts.writeTools).toBeGreaterThan(0);

      // Each tool exposes only the safe projection — no handler/buildUrl leak.
      const sample = body.tools[0];
      expect(sample).toHaveProperty('name');
      expect(sample).toHaveProperty('title');
      expect(sample).toHaveProperty('description');
      expect(sample).toHaveProperty('requiredScope');
      expect(sample).toHaveProperty('destructive');
      expect(sample).toHaveProperty('readOnly');
      expect(sample).toHaveProperty('envScoped');
      expect(sample).not.toHaveProperty('handler');
      expect(sample).not.toHaveProperty('buildUrl');
      expect(sample).not.toHaveProperty('isWrite');

      // Resources carry their URI/template + no build/read internals.
      const resource = body.resources[0];
      expect(resource).toHaveProperty('name');
      expect(resource).toHaveProperty('uriTemplate');
      expect(resource).not.toHaveProperty('build');
      expect(resource).not.toHaveProperty('read');
    });

    it('rejects an operator with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/mcp',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects a viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/mcp',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/mcp' });
      expect(res.statusCode).toBe(401);
    });
  });
});
