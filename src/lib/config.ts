import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/bridgeport.db'),
  MASTER_KEY: z.string().min(1, 'MASTER_KEY is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  DO_REGISTRY_TOKEN: z.string().optional(),
  SSH_KEY_PATH: z.string().default('/root/.ssh/bios-infra'),
  SSH_USER: z.string().default('root'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  UPLOAD_DIR: z.string().default('./uploads'),
  // Initial admin user (created on first boot if no users exist)
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
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
  // Internal URL for agent to connect back to BridgePort
  // Should be the internal/VPC IP that monitored servers can reach
  AGENT_CALLBACK_URL: z.string().optional(), // e.g., "http://10.30.10.5:3000"
  // CORS origin(s) - comma-separated list or single origin
  CORS_ORIGIN: z.string().optional(), // e.g., "https://deploy.bridgein.com"
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
