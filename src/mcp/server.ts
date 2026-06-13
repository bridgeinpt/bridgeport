/**
 * buildMcpServer — assemble a per-request McpServer instance for a caller
 * (issue #208).
 *
 * The transport is stateless (one McpServer per incoming POST), so this is
 * called fresh for every request. It computes the caller's scopes via
 * `computeScopes` and registers ONLY the tools whose `requiredScope` is null
 * or present in those scopes — so a viewer token sees the read + meta tools,
 * while an operator/admin token additionally sees the write tools.
 *
 * Env-scoped API tokens (`scope.allEnvironments === false`) additionally have
 * every GLOBAL-route tool withheld (`tool.envScoped === false`): such a token
 * can only reach `/api/environments/:envId/...` routes, the scope-exempt
 * environment list/get, and no-scope routes — enforceTokenScope rejects any
 * other (global) route with FORBIDDEN_SCOPE, so advertising those tools (every
 * write tool AND the global read tools like get_server / query_audit_log) would
 * only ever produce guaranteed failures. The result is a TRUTHFUL list: only
 * tools an env-scoped token can actually use.
 *
 * Each tool's handler runs `injectApi` under the hood (see tools.ts) and maps
 * the API envelope to an MCP result; on a non-2xx / ApiError envelope it returns
 * `{ isError: true, content: [{ type: 'text', text: "<code>: <message> | ..." }] }`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { computeScopes } from '../lib/scopes.js';
import { appVersion } from '../lib/version.js';
import type { AuthUser } from '../services/auth.js';
import { ALL_TOOLS } from './tools.js';
import type { McpToolContext, McpToolDef } from './types.js';

export interface BuildMcpServerOptions {
  /** Root Fastify instance (the one whose routes the tools inject into). */
  app: FastifyInstance;
  authUser: AuthUser;
  /** Raw bearer token (without "Bearer " prefix) of the MCP caller. */
  bearer: string;
  /** The caller's real client IP (`request.ip`), threaded onto injected calls. */
  callerIp: string;
}

/**
 * Select the tools a caller holding `scopes` is entitled to. A tool is included
 * iff BOTH hold:
 *   1. Scope: its `requiredScope` is null (meta/read — every valid token) or is
 *      present in `scopes` (write tools need `services:write`).
 *   2. Reachability: it isn't withheld by env-scoping — either the caller is not
 *      env-scoped, or the tool's backing route is reachable by an env-scoped
 *      token (`tool.envScoped === true`).
 *
 * When `isEnvScoped` is true (an env-scoped API token), every tool whose route
 * is GLOBAL (`tool.envScoped === false`) is excluded — it would only ever return
 * FORBIDDEN_SCOPE for such a token, so listing it would be a misleading
 * advertisement. This `envScoped` gate SUBSUMES the prior write-tool exclusion:
 * all write tools are `envScoped:false`, so they're dropped for env-scoped tokens
 * by the same condition (no separate `:write` special-case needed). It also drops
 * the global READ tools (e.g. get_server, query_audit_log) that the old logic
 * left misleadingly listed.
 *
 * Pure and side-effect-free so the scope-gating contract can be unit-tested
 * without the SDK or a transport.
 */
export function selectToolsForScopes(scopes: string[], isEnvScoped = false): McpToolDef[] {
  const scopeSet = new Set(scopes);
  return ALL_TOOLS.filter((tool) => {
    const scopeOk = tool.requiredScope === null || scopeSet.has(tool.requiredScope);
    const reachable = !isEnvScoped || tool.envScoped;
    return scopeOk && reachable;
  });
}

/**
 * Build (but do not connect) an McpServer with the tools this caller is
 * entitled to. The caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(options: BuildMcpServerOptions): McpServer {
  const { app, authUser, bearer, callerIp } = options;

  const server = new McpServer({
    name: 'bridgeport',
    version: appVersion,
  });

  // An env-scoped API token has `scope.allEnvironments === false`. JWT sessions
  // (scope === undefined) and all-environment tokens are NOT env-scoped, so they
  // keep the full surface. Env-scoped tokens get every global-route tool withheld
  // (their routes always FORBIDDEN_SCOPE — see selectToolsForScopes).
  const isEnvScoped = authUser.scope?.allEnvironments === false;

  // Tools available to this session: meta/read (requiredScope null) plus any
  // write tool whose required scope the caller holds — and, for env-scoped
  // tokens, only the ones whose backing route is reachable (tool.envScoped).
  const availableTools = selectToolsForScopes(computeScopes(authUser), isEnvScoped);
  const registeredToolNames = availableTools.map((t) => t.name);

  const ctx: McpToolContext = { app, bearer, authUser, callerIp, registeredToolNames };

  for (const tool of availableTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
        },
      },
      // The SDK validates args against inputSchema before invoking, so `args`
      // is the parsed shape; we widen to Record for the declarative handler.
      // McpToolResult is structurally a CallToolResult (content + isError); the
      // cast supplies the SDK's permissive index signature.
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const result = await tool.handler(args ?? {}, ctx);
        return result as CallToolResult;
      }
    );
  }

  return server;
}
