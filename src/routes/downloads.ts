import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { cliVersion } from '../lib/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIR = join(__dirname, '../../cli');

// Available CLI platforms
const CLI_PLATFORMS = [
  { os: 'darwin', arch: 'amd64', label: 'macOS (Intel)', filename: 'bridgeport-darwin-amd64' },
  { os: 'darwin', arch: 'arm64', label: 'macOS (Apple Silicon)', filename: 'bridgeport-darwin-arm64' },
  { os: 'linux', arch: 'amd64', label: 'Linux (x64)', filename: 'bridgeport-linux-amd64' },
  { os: 'linux', arch: 'arm64', label: 'Linux (ARM64)', filename: 'bridgeport-linux-arm64' },
];

export async function downloadRoutes(fastify: FastifyInstance): Promise<void> {
  // List available CLI downloads
  fastify.get('/api/downloads/cli', async () => {
    const downloads = await Promise.all(
      CLI_PLATFORMS.map(async (platform) => {
        const filePath = join(CLI_DIR, platform.filename);
        try {
          const stats = await stat(filePath);
          return {
            ...platform,
            available: true,
            size: stats.size,
          };
        } catch {
          return {
            ...platform,
            available: false,
            size: 0,
          };
        }
      })
    );

    return {
      version: cliVersion,
      downloads: downloads.filter((d) => d.available),
    };
  });

  // Download CLI binary
  fastify.get('/api/downloads/cli/:os/:arch', async (request, reply) => {
    const { os, arch } = request.params as { os: string; arch: string };

    const platform = CLI_PLATFORMS.find((p) => p.os === os && p.arch === arch);
    if (!platform) {
      return reply.code(404).send({ error: 'Platform not found' });
    }

    const filePath = join(CLI_DIR, platform.filename);

    try {
      const stats = await stat(filePath);

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${platform.filename}"`);
      reply.header('Content-Length', stats.size);

      return reply.send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'Binary not available' });
    }
  });
}
