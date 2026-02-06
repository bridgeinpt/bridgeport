import pg from 'pg';
import mysql from 'mysql2/promise';
import { SSHClient, LocalClient, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { decrypt } from '../lib/crypto.js';

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
  connectionMode: 'sql' | 'ssh';
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

/**
 * Execute all monitoring queries and return results as a record.
 * Each query result is keyed by its name. Errors per-query are captured without aborting others.
 */
export async function executeMonitoringQueries(
  config: MonitoringConfig,
  sqlConn?: SQLConnectionInfo,
  sshConn?: SSHConnectionInfo,
): Promise<Record<string, unknown>> {
  if (config.connectionMode === 'sql' && sqlConn) {
    return executeSQLQueries(config, sqlConn);
  } else if (config.connectionMode === 'ssh' && sshConn) {
    return executeSSHQueries(config, sshConn);
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
