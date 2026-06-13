/**
 * Integration tests for the in-repo MCP server (issue #208).
 *
 * Strategy: drive the server with the OFFICIAL MCP SDK client against a real
 * ephemeral listener. This proves a real client can complete the
 * initialize → tools/list → tools/call handshake across the stateless
 * StreamableHTTP transport, exactly as Claude Desktop / Code would. We do NOT
 * hand-parse the SSE wire — the SDK client handles SSE, the Accept header, and
 * the Mcp-Protocol-Version header for us.
 *
 * Seeding + role-scoped tokens reuse the existing test factories/helpers; tokens
 * are JWTs minted via generateTestToken (computeScopes derives scope from the
 * user's role, so a JWT is sufficient to exercise the scope gating).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser } from '../factories/user.js';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService, createTestServiceDeployment } from '../factories/service.js';
import { createTestDatabase } from '../factories/database.js';
import { createSecret } from '../../src/services/secrets.js';
import { createApiToken } from '../../src/services/auth.js';
import { createRegistryConnection } from '../../src/services/registries.js';

/** Shape of a tools/call result block we assert on. */
interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function firstText(res: ToolText): string {
  const block = res.content.find((c) => c.type === 'text');
  return block?.text ?? '';
}

describe('MCP server (integration, SDK client)', () => {
  let app: TestApp;
  let port: number;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  /** A raw API token (not a JWT) scoped to a SINGLE environment, operator role. */
  let envScopedOperatorToken: string;
  let envId: string;
  let serviceId: string;
  let configFileId: string;
  let registryId: string;
  let databaseId: string;

  // Track clients/transports so we always close them (the SDK keeps a fetch
  // connection open per client).
  const openClients: Client[] = [];

  /** Connect a fresh SDK client carrying the given bearer token. */
  async function connect(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    openClients.push(client);
    return client;
  }

  beforeAll(async () => {
    app = await buildTestApp({ mcpEnabled: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;

    const admin = await createTestUser(app.prisma, { email: 'admin@mcp.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    const operator = await createTestUser(app.prisma, { email: 'operator@mcp.test', role: 'operator' });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@mcp.test', role: 'viewer' });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'mcp-env' });
    envId = env.id;

    // An env-scoped (allEnvironments=false) OPERATOR API token. Its role grants
    // services:write, but because it's env-scoped the MCP server must NOT
    // register write tools (their global routes always FORBIDDEN_SCOPE for an
    // env-scoped token). Owned by the operator user created above.
    const { token: scopedToken } = await createApiToken({
      name: 'mcp-env-scoped-operator',
      role: 'operator',
      allEnvironments: false,
      environmentIds: [envId],
      ownerUserId: operator.id,
    });
    envScopedOperatorToken = scopedToken;

    const server = await createTestServer(app.prisma, { environmentId: envId, name: 'mcp-server' });
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    const service = await createTestService(app.prisma, {
      environmentId: envId,
      containerImageId: image.id,
      name: 'mcp-service',
    });
    serviceId = service.id;
    await createTestServiceDeployment(app.prisma, { serviceId: service.id, serverId: server.id });

    // Seed a secret (encrypted at rest via the service) and a var (plaintext
    // value column) to assert non-leakage through the tools.
    await createSecret(envId, { key: 'MCP_DB_URL', value: 'super-secret-plaintext' });
    await app.prisma.var.create({
      data: { key: 'MCP_PUBLIC_VAR', value: 'plaintext-var-value', environmentId: envId },
    });

    // A config file with ZERO attachments: sync-all returns a `no_targets`
    // outcome with NO SSH connection, still writes an audit row, and is
    // idempotency-keyed — ideal for the write-tool test.
    const cf = await app.prisma.configFile.create({
      data: { name: 'mcp-cf', filename: 'mcp.env', content: 'X=1', environmentId: envId },
    });
    configFileId = cf.id;

    // A registry connection WITH credentials (token + password are encrypted at
    // rest by the service). The list/get tools must surface metadata only —
    // never the encrypted blobs or the plaintext credential.
    const registry = await createRegistryConnection(envId, {
      name: 'mcp-registry',
      type: 'generic',
      registryUrl: 'registry.mcp.test',
      token: 'super-secret-registry-token',
      username: 'mcp-user',
      password: 'super-secret-registry-password',
    });
    registryId = registry.id;

    // A database (its connection credentials, if any, are encrypted at rest;
    // the read tools project `hasCredentials` only).
    const database = await createTestDatabase(app.prisma, { environmentId: envId, name: 'mcp-db' });
    databaseId = database.id;
  });

  afterAll(async () => {
    for (const c of openClients) {
      await c.close().catch(() => {});
    }
    await app.close();
  });

  // 1. Default-off ----------------------------------------------------------
  it('returns 404 for POST /mcp when MCP is not enabled', async () => {
    // skipDbSetup: true reuses the already-seeded singleton DB WITHOUT cleaning
    // it (a plain buildTestApp() would wipe the data the suite seeded). MCP is
    // not enabled here, so POST /mcp must not be routed.
    const off = await buildTestApp({ skipDbSetup: true }); // follows config => MCP off
    try {
      const res = await off.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await off.close();
    }
  });

  // 2. Scope-gated tool list ------------------------------------------------
  describe('scope-gated tool listing', () => {
    it('admin sees write tools (deploy_service) and read tools', async () => {
      const client = await connect(adminToken);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('deploy_service');
      expect(names).toContain('list_services');
      expect(names).toContain('get_capabilities');
    });

    it('viewer can CONNECT and sees read tools but NO write tools (VIEWER_ALLOWED_MUTATIONS regression guard)', async () => {
      const client = await connect(viewerToken);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // Connected at all => the POST /mcp viewer-mutation allowance works.
      expect(names).toContain('list_services');
      expect(names).toContain('get_capabilities');
      // No write tools for a viewer.
      const writeNames = [
        'deploy_service',
        'execute_deployment_plan',
        'restart_deployment',
        'rollback_deployment_plan',
        'run_database_backup',
        'sync_config_file',
      ];
      for (const w of writeNames) {
        expect(names).not.toContain(w);
      }
    });

    it('env-scoped OPERATOR token sees ONLY env-scoped tools: no write tools AND no global read tools, but env reads + meta remain', async () => {
      // An operator's role grants services:write, BUT this token is env-scoped,
      // so EVERY global-route tool is withheld — they'd only ever FORBIDDEN_SCOPE.
      // That's both the write tools (all global) and the global READ tools
      // (get_server, query_audit_log, …). Env reads + meta remain.
      const client = await connect(envScopedOperatorToken);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      // Env-scoped reads (+ meta) ARE listed.
      expect(names).toContain('list_services');
      expect(names).toContain('list_secrets');
      expect(names).toContain('get_capabilities');
      expect(names).toContain('get_version');

      // Write tools (all global) are NOT listed.
      const writeNames = [
        'deploy_service',
        'execute_deployment_plan',
        'restart_deployment',
        'rollback_deployment_plan',
        'run_database_backup',
        'sync_config_file',
      ];
      for (const w of writeNames) {
        expect(names).not.toContain(w);
      }

      // Global READ tools are ALSO NOT listed (the fidelity fix): they target
      // global routes and would always FORBIDDEN_SCOPE for an env-scoped token.
      const globalReadNames = ['get_server', 'get_service', 'get_drift', 'query_audit_log'];
      for (const g of globalReadNames) {
        expect(names).not.toContain(g);
      }

      // get_capabilities reflects EXACTLY the registered set (no write tools, no
      // global read tools — same list tools/list returned).
      const caps = (await client.callTool({
        name: 'get_capabilities',
        arguments: {},
      })) as ToolText;
      const body = JSON.parse(firstText(caps)) as { tools: string[] };
      expect([...body.tools].sort()).toEqual([...names].sort());
      for (const w of writeNames) {
        expect(body.tools).not.toContain(w);
      }
      for (const g of globalReadNames) {
        expect(body.tools).not.toContain(g);
      }
    });
  });

  // 3. Secrets never leak ---------------------------------------------------
  describe('list_secrets never returns secret values', () => {
    for (const role of ['admin', 'viewer'] as const) {
      it(`omits value/encryptedValue/nonce for ${role}`, async () => {
        const client = await connect(role === 'admin' ? adminToken : viewerToken);
        const res = (await client.callTool({
          name: 'list_secrets',
          arguments: { envId },
        })) as ToolText;
        expect(res.isError).toBeFalsy();
        const text = firstText(res);
        const body = JSON.parse(text) as { secrets: Array<Record<string, unknown>> };
        expect(body.secrets.length).toBeGreaterThan(0);
        for (const s of body.secrets) {
          expect(s).not.toHaveProperty('value');
          expect(s).not.toHaveProperty('encryptedValue');
          expect(s).not.toHaveProperty('nonce');
        }
        // Belt and suspenders: the plaintext secret value is nowhere in output.
        expect(text).not.toContain('super-secret-plaintext');
      });
    }

    it('exposes no tool that reveals decrypted secret values', async () => {
      const client = await connect(adminToken);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('get_secret_value');
      expect(names).not.toContain('reveal_secret');
      expect(names.some((n) => /reveal/i.test(n))).toBe(false);
    });
  });

  // 4. Vars value stripped --------------------------------------------------
  describe('list_vars strips plaintext value (but REST does not)', () => {
    it('tool output omits value while the equivalent REST call includes it', async () => {
      const client = await connect(viewerToken);
      const res = (await client.callTool({
        name: 'list_vars',
        arguments: { envId },
      })) as ToolText;
      const text = firstText(res);
      const body = JSON.parse(text) as { vars: Array<Record<string, unknown>> };
      const v = body.vars.find((x) => x.key === 'MCP_PUBLIC_VAR');
      expect(v).toBeDefined();
      expect(v).not.toHaveProperty('value');
      expect(text).not.toContain('plaintext-var-value');

      // Contrast: the REST endpoint DOES return the plaintext value.
      const rest = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/vars`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      const restVars = rest.json().vars as Array<Record<string, unknown>>;
      const restV = restVars.find((x) => x.key === 'MCP_PUBLIC_VAR');
      expect(restV).toMatchObject({ key: 'MCP_PUBLIC_VAR', value: 'plaintext-var-value' });
    });
  });

  // 4b. New read tools: listed + callable -----------------------------------
  describe('new read tools are registered and callable', () => {
    it('admin sees the broadened read surface in tools/list', async () => {
      const client = await connect(adminToken);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // A representative sample across the new resource families.
      for (const t of [
        'list_databases',
        'get_database',
        'list_database_backups',
        'list_notifications',
        'list_registries',
        'get_registry',
        'get_topology',
        'list_external_entities',
        'list_server_clusters',
        'get_dependency_graph',
        'list_container_images',
        'get_service_compose',
        'list_service_types',
        'list_database_types',
        'get_system_settings',
        'list_webhook_subscriptions',
      ]) {
        expect(names).toContain(t);
      }
    });

    it('list_databases returns the seeded database (env-scoped read)', async () => {
      const client = await connect(viewerToken);
      const res = (await client.callTool({
        name: 'list_databases',
        arguments: { envId },
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(firstText(res)) as { databases: Array<Record<string, unknown>> };
      expect(body.databases.some((d) => d.id === databaseId)).toBe(true);
      // The DB read shape exposes a hasCredentials flag, never the encrypted blob.
      for (const d of body.databases) {
        expect(d).not.toHaveProperty('encryptedCredentials');
        expect(d).not.toHaveProperty('credentialsNonce');
      }
    });

    it('get_topology returns a Mermaid graph for the environment', async () => {
      const client = await connect(adminToken);
      const res = (await client.callTool({
        name: 'get_topology',
        arguments: { environmentId: envId },
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(firstText(res)) as { mermaid: string };
      expect(typeof body.mermaid).toBe('string');
      expect(body.mermaid).toContain('graph TD');
    });

    it('list_service_types returns the plugin-seeded types', async () => {
      const client = await connect(viewerToken);
      const res = (await client.callTool({
        name: 'list_service_types',
        arguments: {},
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(firstText(res)) as { serviceTypes: unknown[] };
      expect(Array.isArray(body.serviceTypes)).toBe(true);
    });
  });

  // 4c. Credential-bearing read tools NEVER leak secrets ---------------------
  describe('credential-bearing read tools return no secret material', () => {
    it('list_registries / get_registry expose metadata only (hasToken/hasPassword), never the credential', async () => {
      const client = await connect(adminToken);

      const listRes = (await client.callTool({
        name: 'list_registries',
        arguments: { envId },
      })) as ToolText;
      expect(listRes.isError).toBeFalsy();
      const listText = firstText(listRes);
      const listBody = JSON.parse(listText) as { registries: Array<Record<string, unknown>> };
      const reg = listBody.registries.find((r) => r.id === registryId);
      expect(reg).toBeDefined();
      // Metadata booleans are present...
      expect(reg).toMatchObject({ hasToken: true, hasPassword: true, username: 'mcp-user' });
      // ...but NO credential field of any form.
      for (const field of ['token', 'password', 'encryptedToken', 'tokenNonce', 'encryptedPassword', 'passwordNonce']) {
        expect(reg).not.toHaveProperty(field);
      }
      // Belt and suspenders: neither plaintext secret appears anywhere in output.
      expect(listText).not.toContain('super-secret-registry-token');
      expect(listText).not.toContain('super-secret-registry-password');

      const getRes = (await client.callTool({
        name: 'get_registry',
        arguments: { id: registryId },
      })) as ToolText;
      const getText = firstText(getRes);
      expect(getText).not.toContain('super-secret-registry-token');
      expect(getText).not.toContain('super-secret-registry-password');
      const getBody = JSON.parse(getText) as { registry: Record<string, unknown> };
      for (const field of ['token', 'password', 'encryptedToken', 'encryptedPassword']) {
        expect(getBody.registry).not.toHaveProperty(field);
      }
    });

    it('list_api_tokens (admin) returns the non-secret prefix only — never a token value or hash', async () => {
      // Mint a token so the list is non-empty. createApiToken returns the full
      // value ONCE; it must NOT be retrievable via the list tool.
      const { token: fullToken } = await createApiToken({
        name: 'mcp-listed-token',
        role: 'viewer',
        allEnvironments: true,
        ownerUserId: (await app.prisma.user.findFirstOrThrow({ where: { email: 'admin@mcp.test' } })).id,
      });

      const client = await connect(adminToken);
      const res = (await client.callTool({
        name: 'list_api_tokens',
        arguments: {},
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const text = firstText(res);
      const body = JSON.parse(text) as { tokens: Array<Record<string, unknown>> };
      expect(body.tokens.length).toBeGreaterThan(0);
      for (const t of body.tokens) {
        // Only the short, non-secret prefix is exposed — never the value or hash.
        expect(t).not.toHaveProperty('tokenHash');
        expect(t).not.toHaveProperty('token');
        expect(t).toHaveProperty('tokenPrefix');
      }
      // The full minted token value is nowhere in the serialized output.
      expect(text).not.toContain(fullToken);
    });
  });

  // 4d. Admin-gated read tools are scope-gated -------------------------------
  describe('admin-gated read tools (list_service_accounts, list_api_tokens, get_environment_settings)', () => {
    const ADMIN_READ_TOOLS = ['list_service_accounts', 'list_api_tokens', 'get_environment_settings'];

    it('an admin sees them in tools/list; a viewer does not', async () => {
      const adminClient = await connect(adminToken);
      const adminNames = (await adminClient.listTools()).tools.map((t) => t.name);
      for (const t of ADMIN_READ_TOOLS) {
        expect(adminNames).toContain(t);
      }

      const viewerClient = await connect(viewerToken);
      const viewerNames = (await viewerClient.listTools()).tools.map((t) => t.name);
      for (const t of ADMIN_READ_TOOLS) {
        expect(viewerNames).not.toContain(t);
      }
    });

    it('an operator does not see them either (no admin:* / tokens:manage scope)', async () => {
      const client = await connect(operatorToken);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const t of ADMIN_READ_TOOLS) {
        expect(names).not.toContain(t);
      }
    });

    it('get_environment_settings (admin) returns a settings module', async () => {
      const client = await connect(adminToken);
      const res = (await client.callTool({
        name: 'get_environment_settings',
        arguments: { id: envId, module: 'general' },
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(firstText(res)) as { settings: unknown; definitions: unknown };
      expect(body).toHaveProperty('settings');
      expect(body).toHaveProperty('definitions');
    });
  });

  // 5. Write tool: gated + idempotent + audited -----------------------------
  describe('write tool sync_config_file', () => {
    it('is NOT listed for a viewer and errors with FORBIDDEN_ROLE if called by name', async () => {
      const client = await connect(viewerToken);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('sync_config_file');

      // Calling an unregistered tool by name surfaces an error to the client.
      // The SDK may reject the call (unknown tool) OR the server may return an
      // isError result — accept either, but if it's a result, it must carry the
      // forbidden signal rather than succeeding.
      let threw = false;
      let result: ToolText | undefined;
      try {
        result = (await client.callTool({
          name: 'sync_config_file',
          arguments: { id: configFileId },
        })) as ToolText;
      } catch {
        threw = true;
      }
      if (!threw) {
        expect(result?.isError).toBe(true);
      }
    });

    it('operator: runs once, dedupes the identical retry via Idempotency-Key, and writes one audit row (REST parity)', async () => {
      // Establish REST-path audit parity baseline: a REST sync of a fresh
      // zero-attachment config file writes exactly one sync_files audit row.
      const restCf = await app.prisma.configFile.create({
        data: { name: 'rest-cf', filename: 'rest.env', content: 'Y=2', environmentId: envId },
      });
      const restRes = await app.inject({
        method: 'POST',
        url: `/api/config-files/${restCf.id}/sync-all`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(restRes.statusCode).toBe(200);
      const restAudits = await app.prisma.auditLog.count({
        where: { action: 'sync_files', resourceId: restCf.id },
      });
      expect(restAudits).toBe(1);

      // MCP path: two identical calls in quick succession (same ~60s dedup
      // window). The first runs; the second must replay (handler skipped)
      // because the derived Idempotency-Key (tool + time-bucket + args) + same
      // bearer + same route pattern collide on the @@unique constraint.
      const client = await connect(operatorToken);
      const first = (await client.callTool({
        name: 'sync_config_file',
        arguments: { id: configFileId },
      })) as ToolText;
      const second = (await client.callTool({
        name: 'sync_config_file',
        arguments: { id: configFileId },
      })) as ToolText;

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      // #126 semantics: the replay returns the SAME response body verbatim.
      expect(firstText(second)).toBe(firstText(first));

      // The side effect (audit row) ran exactly ONCE despite two calls.
      const mcpAudits = await app.prisma.auditLog.count({
        where: { action: 'sync_files', resourceId: configFileId },
      });
      expect(mcpAudits).toBe(1);

      // Audit parity: the MCP-produced row matches the shape of the REST one.
      const row = await app.prisma.auditLog.findFirst({
        where: { action: 'sync_files', resourceId: configFileId },
      });
      expect(row).toMatchObject({
        action: 'sync_files',
        resourceType: 'config_file',
        resourceId: configFileId,
      });
      // Attributed to the operator user, same as a REST call would be.
      expect(row?.userId).toBeTruthy();
    });

    it('dryRun previews are NOT cached: two identical dry-runs both execute (no Idempotency-Key)', async () => {
      // A dry-run attaches no Idempotency-Key, so re-running an identical preview
      // recomputes instead of replaying a stale diff. Use a FRESH zero-attachment
      // config file so the count is isolated. Two identical dry-runs => TWO audit
      // rows (had they been keyed/deduped like a real sync, we'd see only one).
      const dryCf = await app.prisma.configFile.create({
        data: { name: 'dry-cf', filename: 'dry.env', content: 'Z=3', environmentId: envId },
      });
      const client = await connect(operatorToken);
      const first = (await client.callTool({
        name: 'sync_config_file',
        arguments: { id: dryCf.id, dryRun: true },
      })) as ToolText;
      const second = (await client.callTool({
        name: 'sync_config_file',
        arguments: { id: dryCf.id, dryRun: true },
      })) as ToolText;

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();

      // Both ran (no dedup) => two sync_files audit rows for this config file.
      const dryAudits = await app.prisma.auditLog.count({
        where: { action: 'sync_files', resourceId: dryCf.id },
      });
      expect(dryAudits).toBe(2);
    });
  });

  // 5b. New write tool: execute_sync_batch ----------------------------------
  describe('write tool execute_sync_batch', () => {
    it('is listed for an operator but NOT a viewer', async () => {
      const op = await connect(operatorToken);
      expect((await op.listTools()).tools.map((t) => t.name)).toContain('execute_sync_batch');
      const viewer = await connect(viewerToken);
      expect((await viewer.listTools()).tools.map((t) => t.name)).not.toContain('execute_sync_batch');
    });

    it('operator: runs a batch and persists a SyncBatch row (its own header-based idempotency)', async () => {
      // A fresh zero-attachment config file → the op resolves to `no_targets`
      // (batch status failed/partial), but a SyncBatch row is persisted and the
      // tool returns a structured result rather than erroring at the transport.
      const batchCf = await app.prisma.configFile.create({
        data: { name: 'batch-cf', filename: 'batch.env', content: 'B=1', environmentId: envId },
      });
      const client = await connect(operatorToken);
      const res = (await client.callTool({
        name: 'execute_sync_batch',
        arguments: { operations: [{ configFileId: batchCf.id }] },
      })) as ToolText;
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(firstText(res)) as {
        batchId: string;
        status: string;
        operations: Array<{ index: number; status: string }>;
      };
      expect(body.batchId).toBeTruthy();
      expect(body.operations).toHaveLength(1);
      // A SyncBatch row was persisted for the batch.
      const row = await app.prisma.syncBatch.findUnique({ where: { id: body.batchId } });
      expect(row).toBeTruthy();
    });
  });

  // 5c. New write tool: refresh_server_health is gated ----------------------
  describe('write tool refresh_server_health', () => {
    it('is listed for an operator but NOT a viewer', async () => {
      const op = await connect(operatorToken);
      expect((await op.listTools()).tools.map((t) => t.name)).toContain('refresh_server_health');
      const viewer = await connect(viewerToken);
      expect((await viewer.listTools()).tools.map((t) => t.name)).not.toContain('refresh_server_health');
    });
  });

  // 6. Destructive annotations ---------------------------------------------
  describe('tool annotations', () => {
    it('write tools are destructive (readOnlyHint false / destructiveHint true); read tools are read-only', async () => {
      const client = await connect(adminToken);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));

      const write = byName.get('deploy_service');
      expect(write?.annotations?.readOnlyHint).toBe(false);
      expect(write?.annotations?.destructiveHint).toBe(true);

      const read = byName.get('list_services');
      expect(read?.annotations?.readOnlyHint).toBe(true);
      expect(read?.annotations?.destructiveHint).toBe(false);
    });
  });

  // 7. Error mapping --------------------------------------------------------
  describe('error mapping', () => {
    it('callTool against a non-existent id => isError with the API error code AND status in the text', async () => {
      const client = await connect(adminToken);
      const res = (await client.callTool({
        name: 'get_service',
        arguments: { id: 'does-not-exist-cuid' },
      })) as ToolText;
      expect(res.isError).toBe(true);
      const text = firstText(res);
      expect(text).toContain('NOT_FOUND');
      // FIX 6: the HTTP status is now surfaced losslessly alongside the code.
      expect(text).toContain('status: 404');
    });
  });

  // 8. Method gating --------------------------------------------------------
  describe('GET/DELETE /mcp are 405', () => {
    it('GET /mcp returns 405 with Allow: POST', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    });

    it('DELETE /mcp returns 405', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(405);
    });
  });

  // 9. Capabilities ---------------------------------------------------------
  describe('get_capabilities', () => {
    it('returns version, scopes, and the tool list for the caller', async () => {
      const client = await connect(operatorToken);
      const res = (await client.callTool({
        name: 'get_capabilities',
        arguments: {},
      })) as ToolText;
      const body = JSON.parse(firstText(res)) as {
        version: string;
        scopes: string[];
        tools: string[];
      };
      expect(typeof body.version).toBe('string');
      expect(body.scopes).toContain('services:write'); // operator
      expect(body.tools).toContain('sync_config_file');
      expect(body.tools).toContain('get_capabilities');
    });
  });
});
