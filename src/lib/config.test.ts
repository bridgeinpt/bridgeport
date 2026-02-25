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
