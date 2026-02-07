import pg from 'pg';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import { SSHClient, LocalClient, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { decrypt } from '../lib/crypto.js';
import { getEnvironmentSshKey } from '../routes/environments.js';

export interface MonitoringQuery {
  name: string;
  displayName: string;
  query: string;
  resultType: 'scalar' | 'row' | 'rows';
  unit?: string;
  chartGroup?: string;
  resultMapping?: Record<string, string>;
}

export interface MonitoringConfig {
  connectionMode: 'sql' | 'ssh' | 'redis';
  driver?: 'pg' | 'mysql2';
  queries: MonitoringQuery[];
}

export interface SQLConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

export interface SSHConnectionInfo {
  hostname: string;
  sshUser: string;
  sshPrivateKey: string;
  filePath?: string;
  placeholders?: Record<string, string>;
}

export interface RedisConnectionInfo {
  host: string;
  port: number;
  password?: string;
}

/**
 * Execute all monitoring queries and return results as a record.
 * Each query result is keyed by its name. Errors per-query are captured without aborting others.
 */
export async function executeMonitoringQueries(
  config: MonitoringConfig,
  sqlConn?: SQLConnectionInfo,
  sshConn?: SSHConnectionInfo,
  redisConn?: RedisConnectionInfo,
): Promise<Record<string, unknown>> {
  if (config.connectionMode === 'sql' && sqlConn) {
    return executeSQLQueries(config, sqlConn);
  } else if (config.connectionMode === 'ssh' && sshConn) {
    return executeSSHQueries(config, sshConn);
  } else if (config.connectionMode === 'redis' && redisConn) {
    return executeRedisQueries(config, redisConn);
  }
  throw new Error(`Unsupported connection mode: ${config.connectionMode}`);
}

async function executeSQLQueries(
  config: MonitoringConfig,
  conn: SQLConnectionInfo,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  if (config.driver === 'pg') {
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
    });

    try {
      await client.connect();

      for (const query of config.queries) {
        try {
          const res = await client.query(query.query);
          results[query.name] = parseQueryResult(query, res.rows);
        } catch (err) {
          results[query.name] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
    } finally {
      await client.end().catch(() => {});
    }
  } else if (config.driver === 'mysql2') {
    const connection = await mysql.createConnection({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      connectTimeout: 10000,
    });

    try {
      for (const query of config.queries) {
        try {
          const [rows] = await connection.execute({ sql: query.query, timeout: 30000 });
          results[query.name] = parseQueryResult(query, rows as Record<string, unknown>[]);
        } catch (err) {
          results[query.name] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
    } finally {
      await connection.end().catch(() => {});
    }
  }

  return results;
}

async function executeSSHQueries(
  config: MonitoringConfig,
  conn: SSHConnectionInfo,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  let client: CommandClient;
  if (isLocalhost(conn.hostname)) {
    client = new LocalClient();
  } else {
    const sshClient = new SSHClient({
      hostname: conn.hostname,
      username: conn.sshUser,
      privateKey: conn.sshPrivateKey,
    });
    await sshClient.connect();
    client = sshClient;
  }

  try {
    for (const query of config.queries) {
      try {
        // Replace placeholders in query
        let cmd = query.query;
        if (conn.placeholders) {
          for (const [key, value] of Object.entries(conn.placeholders)) {
            cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
          }
        }
        if (conn.filePath) {
          cmd = cmd.replace(/\{\{filePath\}\}/g, conn.filePath);
        }

        const result = await client.exec(cmd);
        const stdout = result.stdout.trim();

        if (query.resultType === 'scalar') {
          // Parse single value from stdout
          const value = parseScalarOutput(stdout);
          results[query.name] = value;
        } else if (query.resultType === 'rows') {
          // Try to parse JSON output
          try {
            results[query.name] = JSON.parse(stdout);
          } catch {
            results[query.name] = stdout;
          }
        } else {
          results[query.name] = stdout;
        }
      } catch (err) {
        results[query.name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  } finally {
    if ('disconnect' in client && typeof client.disconnect === 'function') {
      client.disconnect();
    }
  }

  return results;
}

/**
 * Parse Redis INFO output into a key-value map.
 */
function parseRedisInfo(info: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of info.split('\r\n')) {
    if (line.startsWith('#') || !line.includes(':')) continue;
    const colonIdx = line.indexOf(':');
    map.set(line.slice(0, colonIdx), line.slice(colonIdx + 1));
  }
  return map;
}

/**
 * Parse keyspace entries (e.g. "keys=5,expires=0,avg_ttl=0") from Redis INFO.
 */
function parseKeyspaceField(infoMap: Map<string, string>, field: string): number {
  let total = 0;
  for (const [key, value] of infoMap.entries()) {
    if (!key.startsWith('db')) continue;
    // value format: "keys=123,expires=45,avg_ttl=0"
    for (const part of value.split(',')) {
      const [k, v] = part.split('=');
      if (k === field) {
        total += Number(v) || 0;
      }
    }
  }
  return total;
}

async function executeRedisQueries(
  config: MonitoringConfig,
  conn: RedisConnectionInfo,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  const client = new Redis({
    host: conn.host,
    port: conn.port,
    password: conn.password || undefined,
    connectTimeout: 10000,
    commandTimeout: 10000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  client.on('error', () => {}); // Prevent unhandled error events

  try {
    await client.connect();

    // Fetch all INFO sections at once
    const infoRaw = await client.info();
    const infoMap = parseRedisInfo(infoRaw);

    for (const query of config.queries) {
      try {
        const dsl = query.query;

        if (dsl.startsWith('INFO:')) {
          const fields = dsl.slice(5).split(',');
          if (fields.length === 1) {
            // Scalar: single field
            const raw = infoMap.get(fields[0]);
            const num = Number(raw);
            results[query.name] = raw === undefined ? null : isNaN(num) ? raw : num;
          } else {
            // Row: multiple fields
            const row: Record<string, unknown> = {};
            for (const f of fields) {
              const raw = infoMap.get(f.trim());
              const num = Number(raw);
              row[f.trim()] = raw === undefined ? null : isNaN(num) ? raw : num;
            }
            results[query.name] = row;
          }
        } else if (dsl.startsWith('CMD:')) {
          const cmd = dsl.slice(4).trim();
          const parts = cmd.split(/\s+/);
          const res = await (client as unknown as { call: (cmd: string, ...args: string[]) => Promise<unknown> }).call(parts[0], ...parts.slice(1));
          const num = Number(res);
          results[query.name] = isNaN(num) ? res : num;
        } else if (dsl.startsWith('KEYSPACE:')) {
          const field = dsl.slice(9).trim();
          results[query.name] = parseKeyspaceField(infoMap, field);
        } else if (dsl.startsWith('COMPUTED:')) {
          const expr = dsl.slice(9).trim();
          if (expr === 'hit_ratio') {
            const hits = Number(infoMap.get('keyspace_hits')) || 0;
            const misses = Number(infoMap.get('keyspace_misses')) || 0;
            const total = hits + misses;
            results[query.name] = total === 0 ? 0 : Math.round((hits / total) * 10000) / 100;
          } else {
            results[query.name] = { error: `Unknown computed expression: ${expr}` };
          }
        } else {
          results[query.name] = { error: `Unknown Redis query DSL: ${dsl}` };
        }
      } catch (err) {
        results[query.name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  } finally {
    await client.quit().catch(() => {});
  }

  return results;
}

export interface PingResult {
  success: boolean;
  latencyMs: number | null;
  serverVersion?: string;
  error?: string;
}

interface DatabaseForPing {
  type: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  encryptedCredentials: string | null;
  credentialsNonce: string | null;
  filePath: string | null;
  server: { hostname: string } | null;
}

/**
 * Lightweight connection test for a database.
 * For SQL databases: connects and runs SELECT 1.
 * For SQLite: SSH to server and check file exists.
 */
export async function pingDatabase(
  database: DatabaseForPing,
  environmentId: string,
): Promise<PingResult> {
  const start = Date.now();

  // Decrypt credentials if present
  let credentials: { username?: string; password?: string } | undefined;
  if (database.encryptedCredentials && database.credentialsNonce) {
    const decrypted = decrypt(database.encryptedCredentials, database.credentialsNonce);
    if (decrypted.includes(':')) {
      const [username, ...rest] = decrypted.split(':');
      credentials = { username, password: rest.join(':') };
    } else {
      credentials = { password: decrypted };
    }
  }

  if (database.type === 'postgres') {
    const client = new pg.Client({
      host: database.host || 'localhost',
      port: database.port || 5432,
      database: database.databaseName || 'postgres',
      user: credentials?.username || 'postgres',
      password: credentials?.password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      statement_timeout: 5000,
    });

    try {
      await client.connect();
      const res = await client.query('SELECT version()');
      const latencyMs = Date.now() - start;
      const serverVersion = res.rows[0]?.version as string | undefined;
      return { success: true, latencyMs, serverVersion };
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (database.type === 'mysql') {
    const connection = await mysql.createConnection({
      host: database.host || 'localhost',
      port: database.port || 3306,
      database: database.databaseName || undefined,
      user: credentials?.username || 'root',
      password: credentials?.password,
      connectTimeout: 10000,
    });

    try {
      const [rows] = await connection.execute('SELECT VERSION() AS version');
      const latencyMs = Date.now() - start;
      const serverVersion = (rows as { version: string }[])[0]?.version;
      return { success: true, latencyMs, serverVersion };
    } finally {
      await connection.end().catch(() => {});
    }
  }

  if (database.type === 'redis') {
    const client = new Redis({
      host: database.host || 'localhost',
      port: database.port || 6379,
      password: credentials?.password || undefined,
      connectTimeout: 10000,
      commandTimeout: 10000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    client.on('error', () => {}); // Prevent unhandled error events

    try {
      await client.connect();
      const info = await client.info('server');
      const latencyMs = Date.now() - start;
      const versionMatch = info.match(/redis_version:(\S+)/);
      const serverVersion = versionMatch ? `Redis ${versionMatch[1]}` : 'Redis';
      return { success: true, latencyMs, serverVersion };
    } finally {
      await client.quit().catch(() => {});
    }
  }

  if (database.type === 'sqlite') {
    if (!database.server) {
      throw new Error('SQLite databases require a server for connection testing');
    }

    const sshCreds = await getEnvironmentSshKey(environmentId);
    if (!sshCreds) {
      throw new Error('SSH key not configured for environment');
    }

    let client: CommandClient;
    if (isLocalhost(database.server.hostname)) {
      client = new LocalClient();
    } else {
      const sshClient = new SSHClient({
        hostname: database.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });
      await sshClient.connect();
      client = sshClient;
    }

    try {
      const filePath = database.filePath || '/tmp/test.db';
      const result = await client.exec(`sqlite3 "${filePath}" "SELECT sqlite_version()"`);
      const latencyMs = Date.now() - start;
      const serverVersion = `SQLite ${result.stdout.trim()}`;
      return { success: true, latencyMs, serverVersion };
    } finally {
      if ('disconnect' in client && typeof client.disconnect === 'function') {
        client.disconnect();
      }
    }
  }

  throw new Error(`Unsupported database type: ${database.type}`);
}

function parseScalarOutput(stdout: string): number | string {
  const num = Number(stdout);
  return isNaN(num) ? stdout : num;
}

function parseQueryResult(
  query: MonitoringQuery,
  rows: Record<string, unknown>[],
): unknown {
  if (query.resultType === 'scalar') {
    if (rows.length === 0) return null;
    const firstRow = rows[0];
    const firstKey = Object.keys(firstRow)[0];
    const value = firstRow[firstKey];
    return typeof value === 'bigint' ? Number(value) : value;
  }

  if (query.resultType === 'row') {
    if (rows.length === 0) return null;
    const row = rows[0];
    if (query.resultMapping) {
      const mapped: Record<string, unknown> = {};
      for (const [resultKey, columnKey] of Object.entries(query.resultMapping)) {
        const value = row[columnKey];
        mapped[resultKey] = typeof value === 'bigint' ? Number(value) : value;
      }
      return mapped;
    }
    // Convert bigints
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      result[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return result;
  }

  if (query.resultType === 'rows') {
    return rows.map(row => {
      if (query.resultMapping) {
        const mapped: Record<string, unknown> = {};
        for (const [resultKey, columnKey] of Object.entries(query.resultMapping)) {
          const value = row[columnKey];
          mapped[resultKey] = typeof value === 'bigint' ? Number(value) : value;
        }
        return mapped;
      }
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        result[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return result;
    });
  }

  return null;
}
