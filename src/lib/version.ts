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

export const bundledAgentVersion = await readVersionFile(join(__dirname, '../../agent/agent-version.txt'));
export const cliVersion = await readVersionFile(join(__dirname, '../../cli/cli-version.txt'));
