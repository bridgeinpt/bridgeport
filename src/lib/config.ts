import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/bridgeport.db'),
  MASTER_KEY: z.string().min(1, 'MASTER_KEY is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  // Legacy fallback SSH settings - prefer per-environment keys configured via UI
  SSH_KEY_PATH: z.string().optional(),
  SSH_USER: z.string().default('root'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  UPLOAD_DIR: z.string().default('./uploads'),
  // Initial admin user (created on first boot if no users exist)
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  // MCP (Model Context Protocol) server — exposes a curated subset of the API
  // as agent tools at POST /mcp. Disabled by default; when off the route is not
  // registered at all (so /mcp → 404). See docs/reference/mcp.md.
  //
  // STRICT parse (NOT z.coerce.boolean()): this is a network-exposed, default-off
  // security toggle, so ONLY "true"/"1" (case-insensitive, trimmed) enable it.
  // `Boolean(str)` (what z.coerce.boolean does) is true for ANY non-empty string,
  // which means a literal `MCP_ENABLED=false` or `=0` would ENABLE the endpoint —
  // a footgun for a feature that must fail closed. "false", "0", "", and unset all
  // disable it here.
  MCP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase() === 'true' || v?.trim() === '1'),
  // Comma-separated list of Host header values clients may send to /mcp (the
  // PUBLIC hostname(s) clients reach the endpoint through, e.g.
  // "mcp.example.com"). When set & non-empty, the MCP transport's DNS-rebinding
  // protection is enabled and limited to these hosts; when unset/empty the
  // protection is OFF (the endpoint is bearer-authenticated). This is decoupled
  // from HOST (the bind address) on purpose — see src/mcp/plugin.ts and
  // docs/reference/mcp.md.
  MCP_ALLOWED_HOSTS: z.string().optional(),
  // Scheduler intervals (in seconds)
  SCHEDULER_ENABLED: z.coerce.boolean().default(true),
  SCHEDULER_SERVER_HEALTH_INTERVAL: z.coerce.number().default(60), // 1 minute
  SCHEDULER_SERVICE_HEALTH_INTERVAL: z.coerce.number().default(60), // 1 minute
  SCHEDULER_DISCOVERY_INTERVAL: z.coerce.number().default(300), // 5 minutes
  SCHEDULER_UPDATE_CHECK_INTERVAL: z.coerce.number().default(1800), // 30 minutes
  SCHEDULER_METRICS_INTERVAL: z.coerce.number().default(300), // 5 minutes - SSH metrics collection
  SCHEDULER_BACKUP_CHECK_INTERVAL: z.coerce.number().default(60), // 1 minute - check for due backups
  // Metrics retention (in days)
  METRICS_RETENTION_DAYS: z.coerce.number().default(7), // Keep metrics for 7 days
  // CORS origin(s) - comma-separated list or single origin
  CORS_ORIGIN: z.string().optional(), // e.g., "https://bridgeport.example.com"
  // Plugin directory for service types and database types
  PLUGINS_DIR: z.string().default('./plugins'),
  // Sentry error monitoring (opt-in via DSN)
  SENTRY_BACKEND_DSN: z.string().url().optional(),
  SENTRY_FRONTEND_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_ENABLED: z.coerce.boolean().default(true),
  // Part E (issue #240): operational tunables. Defaults match the previously
  // hardcoded literals — zero behavior change unless explicitly set. Consumed
  // by later wiring passes; defined here so they parse from the environment.
  SCHEDULER_DATABASE_METRICS_INTERVAL: z.coerce.number().int().min(1).default(60), // seconds
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  SESSION_TTL: z.string().min(1).default('7d'),
  SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
  SQLITE_CACHE_SIZE_KB: z.coerce.number().int().min(1000).default(64000),
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  WEBHOOK_DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  WEBHOOK_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  POSTGRES_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).default(30000),
  IDEMPOTENCY_RETENTION_MS: z.coerce.number().int().min(1000).default(86400000),
  IDEMPOTENCY_STALE_INPROGRESS_MS: z.coerce.number().int().min(1000).default(300000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
