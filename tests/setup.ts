/**
 * Global test setup for BRIDGEPORT backend tests.
 *
 * Sets required environment variables BEFORE any application code loads.
 * This file is referenced in vitest.config.ts setupFiles.
 */

// Use a deterministic 32-byte key for testing (base64-encoded 32 random bytes)
process.env.MASTER_KEY = 'ilyS3JROhJmj8QEYHuoZts8aoK2LG9SHl0EgIn0gsVw='; // 32 bytes
process.env.JWT_SECRET = 'test-jwt-secret-for-bridgeport-tests';
process.env.DATABASE_URL = 'file:./test.db';
process.env.NODE_ENV = 'test';
process.env.SCHEDULER_ENABLED = 'false';
process.env.PLUGINS_DIR = './plugins';
process.env.UPLOAD_DIR = './test-uploads';
