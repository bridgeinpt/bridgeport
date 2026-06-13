import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Tests for config.ts Zod schema validation.
 *
 * Since config.ts executes `loadConfig()` at import time (module-level side effect),
 * we test the schema validation by directly using Zod's safeParse on a re-created
 * schema. We import loadConfig dynamically to avoid the side-effect on import.
 */

// Re-create the schema here to test validation behavior without triggering process.exit
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/bridgeport.db'),
  MASTER_KEY: z.string().min(1, 'MASTER_KEY is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  SSH_KEY_PATH: z.string().optional(),
  SSH_USER: z.string().default('root'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  UPLOAD_DIR: z.string().default('./uploads'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  // STRICT parse — kept in sync with src/lib/config.ts. ONLY "true"/"1"
  // (case-insensitive, trimmed) enable it; everything else disables.
  MCP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase() === 'true' || v?.trim() === '1'),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  SCHEDULER_ENABLED: z.coerce.boolean().default(true),
  SCHEDULER_SERVER_HEALTH_INTERVAL: z.coerce.number().default(60),
  SCHEDULER_SERVICE_HEALTH_INTERVAL: z.coerce.number().default(60),
  SCHEDULER_DISCOVERY_INTERVAL: z.coerce.number().default(300),
  SCHEDULER_UPDATE_CHECK_INTERVAL: z.coerce.number().default(1800),
  SCHEDULER_METRICS_INTERVAL: z.coerce.number().default(300),
  SCHEDULER_BACKUP_CHECK_INTERVAL: z.coerce.number().default(60),
  METRICS_RETENTION_DAYS: z.coerce.number().default(7),
  CORS_ORIGIN: z.string().optional(),
  PLUGINS_DIR: z.string().default('./plugins'),
  SENTRY_BACKEND_DSN: z.string().url().optional(),
  SENTRY_FRONTEND_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_ENABLED: z.coerce.boolean().default(true),
  // Part E (issue #240) operational tunables — kept in sync with src/lib/config.ts.
  SCHEDULER_DATABASE_METRICS_INTERVAL: z.coerce.number().int().min(1).default(60),
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

// Minimal valid env
const validEnv = {
  MASTER_KEY: 'test-master-key',
  JWT_SECRET: 'test-jwt-secret',
};

describe('config', () => {
  describe('required fields', () => {
    it('should fail when MASTER_KEY is missing', () => {
      const result = envSchema.safeParse({ JWT_SECRET: 'secret' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const masterKeyError = result.error.issues.find(i => i.path.includes('MASTER_KEY'));
        expect(masterKeyError).toBeDefined();
      }
    });

    it('should fail when JWT_SECRET is missing', () => {
      const result = envSchema.safeParse({ MASTER_KEY: 'key' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const jwtError = result.error.issues.find(i => i.path.includes('JWT_SECRET'));
        expect(jwtError).toBeDefined();
      }
    });

    it('should fail when MASTER_KEY is empty string', () => {
      const result = envSchema.safeParse({ MASTER_KEY: '', JWT_SECRET: 'secret' });
      expect(result.success).toBe(false);
    });

    it('should fail when JWT_SECRET is empty string', () => {
      const result = envSchema.safeParse({ MASTER_KEY: 'key', JWT_SECRET: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('defaults', () => {
    it('should apply default values for all optional fields', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DATABASE_URL).toBe('file:./data/bridgeport.db');
        expect(result.data.HOST).toBe('0.0.0.0');
        expect(result.data.PORT).toBe(3000);
        expect(result.data.SSH_USER).toBe('root');
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.UPLOAD_DIR).toBe('./uploads');
        expect(result.data.SCHEDULER_ENABLED).toBe(true);
        expect(result.data.PLUGINS_DIR).toBe('./plugins');
        expect(result.data.SENTRY_TRACES_SAMPLE_RATE).toBe(0);
        expect(result.data.SENTRY_ENABLED).toBe(true);
      }
    });

    it('should apply default scheduler intervals', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_SERVER_HEALTH_INTERVAL).toBe(60);
        expect(result.data.SCHEDULER_SERVICE_HEALTH_INTERVAL).toBe(60);
        expect(result.data.SCHEDULER_DISCOVERY_INTERVAL).toBe(300);
        expect(result.data.SCHEDULER_UPDATE_CHECK_INTERVAL).toBe(1800);
        expect(result.data.SCHEDULER_METRICS_INTERVAL).toBe(300);
        expect(result.data.SCHEDULER_BACKUP_CHECK_INTERVAL).toBe(60);
        expect(result.data.METRICS_RETENTION_DAYS).toBe(7);
      }
    });
  });

  describe('PORT coercion', () => {
    it('should coerce string PORT to number', () => {
      const result = envSchema.safeParse({ ...validEnv, PORT: '8080' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
      }
    });

    it('should accept numeric PORT', () => {
      const result = envSchema.safeParse({ ...validEnv, PORT: 4000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(4000);
      }
    });
  });

  describe('NODE_ENV validation', () => {
    it('should accept development', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'development' });
      expect(result.success).toBe(true);
    });

    it('should accept production', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'production' });
      expect(result.success).toBe(true);
    });

    it('should accept test', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'test' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid NODE_ENV', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'staging' });
      expect(result.success).toBe(false);
    });
  });

  describe('ADMIN_EMAIL validation', () => {
    it('should accept a valid email', () => {
      const result = envSchema.safeParse({ ...validEnv, ADMIN_EMAIL: 'admin@example.com' });
      expect(result.success).toBe(true);
    });

    it('should reject an invalid email', () => {
      const result = envSchema.safeParse({ ...validEnv, ADMIN_EMAIL: 'not-an-email' });
      expect(result.success).toBe(false);
    });

    it('should allow ADMIN_EMAIL to be omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_EMAIL).toBeUndefined();
      }
    });
  });

  describe('ADMIN_PASSWORD validation', () => {
    it('should accept a password of 8+ characters', () => {
      const result = envSchema.safeParse({ ...validEnv, ADMIN_PASSWORD: 'longpassword' });
      expect(result.success).toBe(true);
    });

    it('should reject a password shorter than 8 characters', () => {
      const result = envSchema.safeParse({ ...validEnv, ADMIN_PASSWORD: 'short' });
      expect(result.success).toBe(false);
    });
  });

  describe('SCHEDULER_ENABLED coercion', () => {
    it('should coerce string "true" to boolean true', () => {
      const result = envSchema.safeParse({ ...validEnv, SCHEDULER_ENABLED: 'true' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_ENABLED).toBe(true);
      }
    });

    it('should coerce boolean false to false', () => {
      const result = envSchema.safeParse({ ...validEnv, SCHEDULER_ENABLED: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_ENABLED).toBe(false);
      }
    });

    it('should coerce string "false" to true (non-empty string is truthy in z.coerce.boolean)', () => {
      // Note: z.coerce.boolean() uses Boolean() coercion, so "false" (non-empty string) becomes true
      // This matches the actual Zod behavior - the env var must be parsed differently
      const result = envSchema.safeParse({ ...validEnv, SCHEDULER_ENABLED: 'false' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_ENABLED).toBe(true);
      }
    });
  });

  describe('MCP_ENABLED strict parsing (network-exposed security toggle)', () => {
    function mcp(value: string | undefined): boolean {
      const result = envSchema.safeParse(
        value === undefined ? validEnv : { ...validEnv, MCP_ENABLED: value }
      );
      if (!result.success) throw new Error('unexpected parse failure');
      return result.data.MCP_ENABLED;
    }

    it('enables ONLY for "true"/"1" (case-insensitive, whitespace-trimmed)', () => {
      expect(mcp('true')).toBe(true);
      expect(mcp('TRUE')).toBe(true);
      expect(mcp('  True  ')).toBe(true);
      expect(mcp('1')).toBe(true);
      expect(mcp(' 1 ')).toBe(true);
    });

    it('DISABLES for "false"/"0"/""/unset (the footgun z.coerce.boolean would flip on)', () => {
      // The whole point of FIX 2: a literal "false"/"0" must mean OFF, unlike
      // z.coerce.boolean() (which makes any non-empty string truthy).
      expect(mcp('false')).toBe(false);
      expect(mcp('FALSE')).toBe(false);
      expect(mcp('0')).toBe(false);
      expect(mcp('')).toBe(false);
      expect(mcp('yes')).toBe(false); // not an accepted truthy token
      expect(mcp('on')).toBe(false);
      expect(mcp(undefined)).toBe(false); // unset → default off
    });

    it('defaults to false when omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.MCP_ENABLED).toBe(false);
    });
  });

  describe('MCP_ALLOWED_HOSTS', () => {
    it('is optional (undefined when omitted)', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.MCP_ALLOWED_HOSTS).toBeUndefined();
    });

    it('accepts a comma-separated string', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        MCP_ALLOWED_HOSTS: 'mcp.example.com, mcp2.example.com',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.MCP_ALLOWED_HOSTS).toBe('mcp.example.com, mcp2.example.com');
      }
    });
  });

  describe('SENTRY_TRACES_SAMPLE_RATE validation', () => {
    it('should accept 0', () => {
      const result = envSchema.safeParse({ ...validEnv, SENTRY_TRACES_SAMPLE_RATE: '0' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SENTRY_TRACES_SAMPLE_RATE).toBe(0);
      }
    });

    it('should accept 1', () => {
      const result = envSchema.safeParse({ ...validEnv, SENTRY_TRACES_SAMPLE_RATE: '1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SENTRY_TRACES_SAMPLE_RATE).toBe(1);
      }
    });

    it('should accept 0.5', () => {
      const result = envSchema.safeParse({ ...validEnv, SENTRY_TRACES_SAMPLE_RATE: '0.5' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SENTRY_TRACES_SAMPLE_RATE).toBe(0.5);
      }
    });

    it('should reject values greater than 1', () => {
      const result = envSchema.safeParse({ ...validEnv, SENTRY_TRACES_SAMPLE_RATE: '2' });
      expect(result.success).toBe(false);
    });

    it('should reject negative values', () => {
      const result = envSchema.safeParse({ ...validEnv, SENTRY_TRACES_SAMPLE_RATE: '-0.1' });
      expect(result.success).toBe(false);
    });
  });

  describe('SENTRY DSN validation', () => {
    it('should accept a valid URL for SENTRY_BACKEND_DSN', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SENTRY_BACKEND_DSN: 'https://key@sentry.io/12345',
      });
      expect(result.success).toBe(true);
    });

    it('should reject an invalid URL for SENTRY_BACKEND_DSN', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SENTRY_BACKEND_DSN: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('should allow SENTRY DSNs to be omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SENTRY_BACKEND_DSN).toBeUndefined();
        expect(result.data.SENTRY_FRONTEND_DSN).toBeUndefined();
      }
    });
  });

  describe('optional fields', () => {
    it('should allow SSH_KEY_PATH to be omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SSH_KEY_PATH).toBeUndefined();
      }
    });

    it('should allow CORS_ORIGIN to be omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CORS_ORIGIN).toBeUndefined();
      }
    });

    it('should accept CORS_ORIGIN as a string', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        CORS_ORIGIN: 'https://example.com,https://app.example.com',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('scheduler interval coercion', () => {
    it('should coerce string scheduler intervals to numbers', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SCHEDULER_SERVER_HEALTH_INTERVAL: '120',
        SCHEDULER_METRICS_INTERVAL: '600',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_SERVER_HEALTH_INTERVAL).toBe(120);
        expect(result.data.SCHEDULER_METRICS_INTERVAL).toBe(600);
      }
    });
  });

  describe('Part E operational tunables (issue #240)', () => {
    it('applies defaults matching the previously hardcoded literals when unset', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_DATABASE_METRICS_INTERVAL).toBe(60);
        expect(result.data.SCHEDULER_CONCURRENCY).toBe(5);
        expect(result.data.RATE_LIMIT_MAX).toBe(100);
        expect(result.data.RATE_LIMIT_WINDOW).toBe('1 minute');
        expect(result.data.BCRYPT_ROUNDS).toBe(12);
        expect(result.data.SESSION_TTL).toBe('7d');
        expect(result.data.SQLITE_BUSY_TIMEOUT_MS).toBe(5000);
        expect(result.data.SQLITE_CACHE_SIZE_KB).toBe(64000);
        expect(result.data.WEBHOOK_DELIVERY_INTERVAL_MS).toBe(3000);
        expect(result.data.WEBHOOK_DELIVERY_CONCURRENCY).toBe(10);
        expect(result.data.WEBHOOK_DELIVERY_BATCH_SIZE).toBe(50);
        expect(result.data.POSTGRES_CONNECTION_TIMEOUT_MS).toBe(10000);
        expect(result.data.POSTGRES_STATEMENT_TIMEOUT_MS).toBe(30000);
        expect(result.data.IDEMPOTENCY_RETENTION_MS).toBe(86400000);
        expect(result.data.IDEMPOTENCY_STALE_INPROGRESS_MS).toBe(300000);
      }
    });

    it('coerces string env values to numbers', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SCHEDULER_CONCURRENCY: '20',
        BCRYPT_ROUNDS: '10',
        WEBHOOK_DELIVERY_BATCH_SIZE: '200',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SCHEDULER_CONCURRENCY).toBe(20);
        expect(result.data.BCRYPT_ROUNDS).toBe(10);
        expect(result.data.WEBHOOK_DELIVERY_BATCH_SIZE).toBe(200);
      }
    });

    describe('BCRYPT_ROUNDS (min 4, max 15)', () => {
      it('accepts the boundary values 4 and 15', () => {
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '4' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '15' }).success).toBe(true);
      });

      it('rejects values below 4', () => {
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '2' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '3' }).success).toBe(false);
      });

      it('rejects values above 15', () => {
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '99' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '16' }).success).toBe(false);
      });

      it('rejects non-integer values', () => {
        expect(envSchema.safeParse({ ...validEnv, BCRYPT_ROUNDS: '10.5' }).success).toBe(false);
      });
    });

    describe('SCHEDULER_CONCURRENCY (min 1, max 100)', () => {
      it('accepts the boundary values 1 and 100', () => {
        expect(envSchema.safeParse({ ...validEnv, SCHEDULER_CONCURRENCY: '1' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, SCHEDULER_CONCURRENCY: '100' }).success).toBe(true);
      });

      it('rejects 0 and values above 100', () => {
        expect(envSchema.safeParse({ ...validEnv, SCHEDULER_CONCURRENCY: '0' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, SCHEDULER_CONCURRENCY: '101' }).success).toBe(false);
      });
    });

    describe('WEBHOOK_DELIVERY_BATCH_SIZE (min 1, max 500)', () => {
      it('accepts the boundary values 1 and 500', () => {
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_BATCH_SIZE: '1' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_BATCH_SIZE: '500' }).success).toBe(true);
      });

      it('rejects 0 and values above 500', () => {
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_BATCH_SIZE: '0' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_BATCH_SIZE: '501' }).success).toBe(false);
      });
    });

    describe('WEBHOOK_DELIVERY_INTERVAL_MS (min 500)', () => {
      it('accepts 500 but rejects below 500', () => {
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_INTERVAL_MS: '500' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, WEBHOOK_DELIVERY_INTERVAL_MS: '499' }).success).toBe(false);
      });
    });

    describe('SQLITE_CACHE_SIZE_KB (min 1000)', () => {
      it('accepts 1000 but rejects below 1000', () => {
        expect(envSchema.safeParse({ ...validEnv, SQLITE_CACHE_SIZE_KB: '1000' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, SQLITE_CACHE_SIZE_KB: '999' }).success).toBe(false);
      });
    });

    describe('SESSION_TTL / RATE_LIMIT_WINDOW (non-empty strings)', () => {
      it('falls back to defaults when unset', () => {
        const result = envSchema.safeParse(validEnv);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.SESSION_TTL).toBe('7d');
          expect(result.data.RATE_LIMIT_WINDOW).toBe('1 minute');
        }
      });

      it('rejects an empty SESSION_TTL (present-but-empty env var)', () => {
        expect(envSchema.safeParse({ ...validEnv, SESSION_TTL: '' }).success).toBe(false);
      });

      it('rejects an empty RATE_LIMIT_WINDOW (present-but-empty env var)', () => {
        expect(envSchema.safeParse({ ...validEnv, RATE_LIMIT_WINDOW: '' }).success).toBe(false);
      });

      it('accepts non-empty overrides', () => {
        const result = envSchema.safeParse({ ...validEnv, SESSION_TTL: '30d', RATE_LIMIT_WINDOW: '5 minutes' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.SESSION_TTL).toBe('30d');
          expect(result.data.RATE_LIMIT_WINDOW).toBe('5 minutes');
        }
      });
    });

    describe('IDEMPOTENCY_STALE_INPROGRESS_MS / IDEMPOTENCY_RETENTION_MS (min 1000)', () => {
      it('rejects 0 (would make in-progress records instantly stale → double-execute)', () => {
        expect(envSchema.safeParse({ ...validEnv, IDEMPOTENCY_STALE_INPROGRESS_MS: '0' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, IDEMPOTENCY_RETENTION_MS: '0' }).success).toBe(false);
      });

      it('accepts the boundary value 1000', () => {
        expect(envSchema.safeParse({ ...validEnv, IDEMPOTENCY_STALE_INPROGRESS_MS: '1000' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, IDEMPOTENCY_RETENTION_MS: '1000' }).success).toBe(true);
      });
    });

    describe('POSTGRES_CONNECTION_TIMEOUT_MS / POSTGRES_STATEMENT_TIMEOUT_MS (min 1)', () => {
      it('rejects 0 (would mean "wait forever" → wedges the DB-metrics tick)', () => {
        expect(envSchema.safeParse({ ...validEnv, POSTGRES_CONNECTION_TIMEOUT_MS: '0' }).success).toBe(false);
        expect(envSchema.safeParse({ ...validEnv, POSTGRES_STATEMENT_TIMEOUT_MS: '0' }).success).toBe(false);
      });

      it('accepts the boundary value 1', () => {
        expect(envSchema.safeParse({ ...validEnv, POSTGRES_CONNECTION_TIMEOUT_MS: '1' }).success).toBe(true);
        expect(envSchema.safeParse({ ...validEnv, POSTGRES_STATEMENT_TIMEOUT_MS: '1' }).success).toBe(true);
      });
    });
  });

  describe('full valid configuration', () => {
    it('should accept a fully specified configuration', () => {
      const result = envSchema.safeParse({
        MASTER_KEY: 'my-master-key',
        JWT_SECRET: 'my-jwt-secret',
        DATABASE_URL: 'file:./prod.db',
        HOST: '127.0.0.1',
        PORT: '8080',
        SSH_KEY_PATH: '/home/user/.ssh/id_rsa',
        SSH_USER: 'deploy',
        NODE_ENV: 'production',
        UPLOAD_DIR: '/data/uploads',
        ADMIN_EMAIL: 'admin@company.com',
        ADMIN_PASSWORD: 'strongpassword',
        SCHEDULER_ENABLED: 'true',
        SCHEDULER_SERVER_HEALTH_INTERVAL: '120',
        SCHEDULER_SERVICE_HEALTH_INTERVAL: '120',
        SCHEDULER_DISCOVERY_INTERVAL: '600',
        SCHEDULER_UPDATE_CHECK_INTERVAL: '3600',
        SCHEDULER_METRICS_INTERVAL: '600',
        SCHEDULER_BACKUP_CHECK_INTERVAL: '120',
        METRICS_RETENTION_DAYS: '14',
        CORS_ORIGIN: 'https://deploy.example.com',
        PLUGINS_DIR: '/opt/plugins',
        SENTRY_BACKEND_DSN: 'https://key@sentry.io/1',
        SENTRY_FRONTEND_DSN: 'https://key@sentry.io/2',
        SENTRY_ENVIRONMENT: 'production',
        SENTRY_TRACES_SAMPLE_RATE: '0.1',
        SENTRY_ENABLED: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
        expect(result.data.SSH_USER).toBe('deploy');
        expect(result.data.NODE_ENV).toBe('production');
        expect(result.data.METRICS_RETENTION_DAYS).toBe(14);
      }
    });
  });
});
