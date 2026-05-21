import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readVersionFile(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf-8')).trim();
  } catch {
    return 'unknown';
  }
}

// In production the Docker build passes APP_VERSION=YYYYMMDDHH-{sha} so the
// backend can stamp /health and the Sentry release with the real build
// version. The package.json fallback is hit only in dev / unbuilt envs.
async function resolveAppVersion(): Promise<string> {
  const fromEnv = process.env.APP_VERSION;
  if (fromEnv && fromEnv !== 'dev') return fromEnv;
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const appVersion = await resolveAppVersion();
export const bundledAgentVersion = await readVersionFile(join(__dirname, '../../agent/agent-version.txt'));
export const cliVersion = await readVersionFile(join(__dirname, '../../cli/cli-version.txt'));
