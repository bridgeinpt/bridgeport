import type * as cors from '@fastify/cors';
import type { Config } from './config.js';

type CorsConfig = Pick<Config, 'NODE_ENV' | 'CORS_ORIGIN'>;

export function buildCorsOptions(env: CorsConfig): cors.FastifyCorsOptions {
  return {
    origin: env.NODE_ENV === 'development'
      ? true
      : env.CORS_ORIGIN
        ? env.CORS_ORIGIN.split(',').map(s => s.trim())
        : false,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  };
}
