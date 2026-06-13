/**
 * Shared types for the in-repo MCP (Model Context Protocol) server (issue #208).
 *
 * The MCP server is a THIN PROJECTION of the existing HTTP API: each tool
 * handler builds a `{ method, url, body? }` request and replays it through the
 * Fastify app via `app.inject()` carrying the MCP caller's bearer token, so
 * auth, scope enforcement, Zod validation, Idempotency-Key handling (#126), and
 * audit logging all run identically to a REST call. There is NO new business
 * logic here.
 */

import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import type { AuthUser } from '../services/auth.js';

/** A zod "raw shape" — the object form accepted by McpServer.registerTool's `inputSchema`. */
export type ZodRawShape = Record<string, ZodType>;

/**
 * Context handed to every tool handler. It carries the root Fastify instance
 * (for `app.inject`), the caller's raw bearer token (forwarded verbatim on the
 * injected request so the SAME credential is re-authenticated), and the already
 * resolved `AuthUser` (for cheap meta tools like get_capabilities that don't
 * need to round-trip the API).
 */
export interface McpToolContext {
  app: FastifyInstance;
  /** Raw bearer token (without the "Bearer " prefix) of the MCP caller. */
  bearer: string;
  authUser: AuthUser;
  /** Names of the tools registered for this session (for get_capabilities). */
  registeredToolNames: string[];
}

/**
 * The result a tool handler returns. `content` is passthrough JSON of the API
 * envelope serialized as a single text block; `isError` flags an error result
 * so the MCP client surfaces it as a tool error rather than a successful value.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Declarative definition of a single MCP tool. The registry (`tools.ts`) is an
 * array of these; the server (`server.ts`) registers only the ones whose
 * `requiredScope` is null or present in the caller's computed scopes.
 */
export interface McpToolDef {
  /** Stable tool name exposed to clients (snake_case). */
  name: string;
  /** Human-friendly title shown in tool listings. */
  title: string;
  /** Description shown to the model. */
  description: string;
  /** Zod raw shape for the tool's input arguments (may be empty `{}`). */
  inputSchema: ZodRawShape;
  /**
   * Scope a caller must hold for this tool to be registered/listed. `null` for
   * meta tools (get_capabilities) and read tools that everyone with a valid
   * token can use (every role has `*:read`). Write tools use a `*:write` scope.
   */
  requiredScope: string | null;
  /** MCP annotation: the tool may perform a destructive update. */
  destructive: boolean;
  /** MCP annotation: the tool only reads (no side effects beyond the API call). */
  readOnly: boolean;
  /** Whether this tool issues a write (POST) and must carry an Idempotency-Key. */
  isWrite: boolean;
  /**
   * The handler. Inject-backed tools call `injectApi` with a request built from
   * `args`; meta tools (get_capabilities) synthesize a result without injecting.
   */
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>;
}
