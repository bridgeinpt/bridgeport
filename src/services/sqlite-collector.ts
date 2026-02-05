import { SSHClient, LocalClient, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { decrypt } from '../lib/crypto.js';

export interface SqliteConnectionOptions {
  filePath: string;
  server: {
    hostname: string;
  } | null;
  environment: {
    sshPrivateKey: string | null;
    sshUser: string;
  } | null;
}

export interface SqliteMetrics {
  // Essential metrics
  fileSizeBytes: number;
  pageCount: number;
  pageSize: number;
  freePages: number;
  usedPages: number;
  fragmentationPercent: number;

  // WAL mode metrics
  walEnabled: boolean;
  walSizeBytes: number | null;

  // Configuration
  journalMode: string;
  autoVacuum: string;
  cacheSize: number;
  busyTimeout: number;

  // Health
  integrityOk: boolean | null;
  integrityMessage: string | null;

  // Table info
  tableCount: number;
  indexCount: number;
  tables: Array<{
    name: string;
    rowCount: number | null;
    sizeEstimate: number | null;
  }>;
}

export interface SqliteTestResult {
  success: boolean;
  message: string;
  details?: {
    filePath?: string;
    fileSize?: string;
    journalMode?: string;
    pageCount?: number;
  };
}

async function getClient(options: SqliteConnectionOptions): Promise<CommandClient> {
  if (!options.server) {
    throw new Error('Server is required for SQLite monitoring');
  }

  if (isLocalhost(options.server.hostname)) {
    return new LocalClient();
  }

  if (!options.environment?.sshPrivateKey) {
    throw new Error('SSH key not configured for this environment');
  }

  const privateKey = decrypt(
    options.environment.sshPrivateKey,
    // The SSH key is stored with a separate nonce in the environment
    // For now, we assume it's already decrypted or stored directly
    ''
  );

  const client = new SSHClient({
    hostname: options.server.hostname,
    username: options.environment.sshUser || 'root',
    privateKey: options.environment.sshPrivateKey, // Use raw key for now
  });

  return client;
}

export async function testSqliteConnection(
  options: SqliteConnectionOptions
): Promise<SqliteTestResult> {
  let client: CommandClient | null = null;

  try {
    client = await getClient(options);
    await client.connect();

    // Check if file exists
    const existsResult = await client.exec(`test -f "${options.filePath}" && echo "exists"`);
    if (!existsResult.stdout.includes('exists')) {
      return {
        success: false,
        message: `Database file not found: ${options.filePath}`,
      };
    }

    // Get file size
    const sizeResult = await client.exec(
      `stat -c %s "${options.filePath}" 2>/dev/null || stat -f %z "${options.filePath}"`
    );
    const fileSize = parseInt(sizeResult.stdout.trim()) || 0;
    const fileSizeHuman = formatBytes(fileSize);

    // Check if it's a valid SQLite database
    const headerResult = await client.exec(`sqlite3 "${options.filePath}" "SELECT 1" 2>&1`);
    if (headerResult.code !== 0) {
      return {
        success: false,
        message: `Not a valid SQLite database: ${headerResult.stderr || headerResult.stdout}`,
      };
    }

    // Get journal mode
    const journalResult = await client.exec(
      `sqlite3 "${options.filePath}" "PRAGMA journal_mode"`
    );
    const journalMode = journalResult.stdout.trim() || 'unknown';

    // Get page count
    const pageCountResult = await client.exec(
      `sqlite3 "${options.filePath}" "PRAGMA page_count"`
    );
    const pageCount = parseInt(pageCountResult.stdout.trim()) || 0;

    return {
      success: true,
      message: 'Connection successful',
      details: {
        filePath: options.filePath,
        fileSize: fileSizeHuman,
        journalMode,
        pageCount,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Connection failed: ${message}`,
    };
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}

export async function collectSqliteMetrics(
  options: SqliteConnectionOptions
): Promise<SqliteMetrics> {
  let client: CommandClient | null = null;

  try {
    client = await getClient(options);
    await client.connect();

    const filePath = options.filePath;

    // Get file size
    const sizeResult = await client.exec(
      `stat -c %s "${filePath}" 2>/dev/null || stat -f %z "${filePath}"`
    );
    const fileSizeBytes = parseInt(sizeResult.stdout.trim()) || 0;

    // Get basic pragmas with a single command
    const pragmaResult = await client.exec(`sqlite3 "${filePath}" "
      SELECT 'page_count=' || page_count FROM pragma_page_count;
      SELECT 'page_size=' || page_size FROM pragma_page_size;
      SELECT 'freelist_count=' || freelist_count FROM pragma_freelist_count;
      SELECT 'journal_mode=' || journal_mode FROM pragma_journal_mode;
      SELECT 'auto_vacuum=' || auto_vacuum FROM pragma_auto_vacuum;
      SELECT 'cache_size=' || cache_size FROM pragma_cache_size;
      SELECT 'busy_timeout=' || busy_timeout FROM pragma_busy_timeout;
    "`);

    const pragmas = parsePragmaOutput(pragmaResult.stdout);

    const pageCount = parseInt(pragmas.page_count) || 0;
    const pageSize = parseInt(pragmas.page_size) || 4096;
    const freePages = parseInt(pragmas.freelist_count) || 0;
    const usedPages = pageCount - freePages;
    const fragmentationPercent = pageCount > 0 ? (freePages / pageCount) * 100 : 0;

    // Get journal mode
    const journalMode = pragmas.journal_mode || 'unknown';

    // Get auto_vacuum setting
    const autoVacuumValue = parseInt(pragmas.auto_vacuum) || 0;
    const autoVacuum =
      autoVacuumValue === 0 ? 'none' : autoVacuumValue === 1 ? 'full' : 'incremental';

    // Get WAL size if in WAL mode
    let walSizeBytes: number | null = null;
    if (journalMode.toLowerCase() === 'wal') {
      const walSizeResult = await client.exec(
        `stat -c %s "${filePath}-wal" 2>/dev/null || stat -f %z "${filePath}-wal" 2>/dev/null || echo "0"`
      );
      walSizeBytes = parseInt(walSizeResult.stdout.trim()) || 0;
    }

    // Get table and index counts
    const countsResult = await client.exec(`sqlite3 "${filePath}" "
      SELECT 'tables=' || count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';
      SELECT 'indexes=' || count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';
    "`);
    const counts = parsePragmaOutput(countsResult.stdout);
    const tableCount = parseInt(counts.tables) || 0;
    const indexCount = parseInt(counts.indexes) || 0;

    // Get table info (top tables by estimated size)
    const tablesResult = await client.exec(`sqlite3 "${filePath}" "
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
      LIMIT 20;
    "`);

    const tables: SqliteMetrics['tables'] = [];
    const tableNames = tablesResult.stdout.trim().split('\n').filter(Boolean);

    for (const tableName of tableNames.slice(0, 10)) {
      // Limit to 10 tables
      try {
        const rowCountResult = await client.exec(
          `sqlite3 "${filePath}" "SELECT count(*) FROM \\"${tableName}\\""`
        );
        const rowCount = parseInt(rowCountResult.stdout.trim()) || 0;

        // Estimate size based on page count (rough estimate)
        // This is a simplification - actual size would require analyzing the B-tree
        tables.push({
          name: tableName,
          rowCount,
          sizeEstimate: null, // Would need more complex queries to estimate
        });
      } catch {
        tables.push({
          name: tableName,
          rowCount: null,
          sizeEstimate: null,
        });
      }
    }

    // Run integrity check (quick version)
    let integrityOk: boolean | null = null;
    let integrityMessage: string | null = null;
    try {
      const integrityResult = await client.exec(
        `sqlite3 "${filePath}" "PRAGMA integrity_check(1)"`
      );
      const result = integrityResult.stdout.trim();
      integrityOk = result === 'ok';
      integrityMessage = integrityOk ? null : result;
    } catch {
      integrityOk = null;
      integrityMessage = 'Integrity check failed to run';
    }

    return {
      fileSizeBytes,
      pageCount,
      pageSize,
      freePages,
      usedPages,
      fragmentationPercent,
      walEnabled: journalMode.toLowerCase() === 'wal',
      walSizeBytes,
      journalMode,
      autoVacuum,
      cacheSize: Math.abs(parseInt(pragmas.cache_size)) || 0,
      busyTimeout: parseInt(pragmas.busy_timeout) || 0,
      integrityOk,
      integrityMessage,
      tableCount,
      indexCount,
      tables,
    };
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}

function parsePragmaOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }

  return result;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
