import pg from 'pg';

const { Pool } = pg;

export interface PostgresConnectionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
}

export interface PostgresMetrics {
  // Essential metrics
  activeConnections: number;
  idleConnections: number;
  maxConnections: number;
  connectionUsagePercent: number;
  databaseSizeBytes: number;
  cacheHitRatio: number | null;
  transactionsCommitted: number;
  transactionsRolledBack: number;

  // Performance metrics
  tuplesReturned: number;
  tuplesFetched: number;
  tuplesInserted: number;
  tuplesUpdated: number;
  tuplesDeleted: number;
  deadlocks: number;
  tempFilesBytes: number;
  tempFilesCount: number;
  checkpointsWritten: number;
  checkpointsRequested: number;

  // Replication (if applicable)
  replication?: {
    isReplica: boolean;
    replayLagBytes: number | null;
    replayLagSeconds: number | null;
    state: string | null;
  };

  // Table health summary
  tableHealth?: {
    totalTables: number;
    totalDeadTuples: number;
    tablesNeedingVacuum: number;
  };

  // Long running queries
  longRunningQueries: Array<{
    pid: number;
    duration: string;
    state: string;
    query: string;
  }>;

  // Version info
  postgresVersion: string;
  uptimeSeconds: number | null;
}

export interface PostgresTestResult {
  success: boolean;
  message: string;
  details?: {
    version?: string;
    database?: string;
    activeConnections?: number;
    databaseSize?: string;
  };
}

export async function testPostgresConnection(
  options: PostgresConnectionOptions
): Promise<PostgresTestResult> {
  const pool = new Pool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.username,
    password: options.password,
    ssl: options.ssl !== false ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    const client = await pool.connect();

    try {
      // Get version
      const versionResult = await client.query('SELECT version()');
      const version = versionResult.rows[0]?.version || 'unknown';

      // Get current database
      const dbResult = await client.query('SELECT current_database()');
      const database = dbResult.rows[0]?.current_database || options.database;

      // Get connection count
      const connResult = await client.query(`
        SELECT count(*) as count
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);
      const activeConnections = parseInt(connResult.rows[0]?.count) || 0;

      // Get database size
      const sizeResult = await client.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as size
      `);
      const databaseSize = sizeResult.rows[0]?.size || 'unknown';

      return {
        success: true,
        message: 'Connection successful',
        details: {
          version: version.split(' ').slice(0, 2).join(' '),
          database,
          activeConnections,
          databaseSize,
        },
      };
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Connection failed: ${message}`,
    };
  } finally {
    await pool.end();
  }
}

export async function collectPostgresMetrics(
  options: PostgresConnectionOptions
): Promise<PostgresMetrics> {
  const pool = new Pool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.username,
    password: options.password,
    ssl: options.ssl !== false ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    max: 1,
  });

  try {
    const client = await pool.connect();

    try {
      // Get version
      const versionResult = await client.query('SELECT version()');
      const version = versionResult.rows[0]?.version || 'unknown';

      // Get max connections
      const maxConnResult = await client.query('SHOW max_connections');
      const maxConnections = parseInt(maxConnResult.rows[0]?.max_connections) || 100;

      // Get connection stats
      const connStatsResult = await client.query(`
        SELECT
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) as total
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);
      const activeConnections = parseInt(connStatsResult.rows[0]?.active) || 0;
      const idleConnections = parseInt(connStatsResult.rows[0]?.idle) || 0;
      const totalConnections = parseInt(connStatsResult.rows[0]?.total) || 0;

      // Get database size
      const sizeResult = await client.query(`
        SELECT pg_database_size(current_database()) as size
      `);
      const databaseSizeBytes = parseInt(sizeResult.rows[0]?.size) || 0;

      // Get database stats
      const dbStatsResult = await client.query(`
        SELECT
          xact_commit,
          xact_rollback,
          blks_read,
          blks_hit,
          tup_returned,
          tup_fetched,
          tup_inserted,
          tup_updated,
          tup_deleted,
          deadlocks,
          temp_files,
          temp_bytes
        FROM pg_stat_database
        WHERE datname = current_database()
      `);
      const dbStats = dbStatsResult.rows[0] || {};

      // Calculate cache hit ratio
      const blksRead = parseInt(dbStats.blks_read) || 0;
      const blksHit = parseInt(dbStats.blks_hit) || 0;
      const cacheHitRatio =
        blksRead + blksHit > 0 ? blksHit / (blksRead + blksHit) : null;

      // Get checkpoint stats
      const bgwriterResult = await client.query(`
        SELECT checkpoints_timed, checkpoints_req
        FROM pg_stat_bgwriter
      `);
      const bgwriter = bgwriterResult.rows[0] || {};

      // Get uptime
      let uptimeSeconds: number | null = null;
      try {
        const uptimeResult = await client.query(`
          SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::integer as uptime
        `);
        uptimeSeconds = uptimeResult.rows[0]?.uptime || null;
      } catch {
        // pg_postmaster_start_time might not be available in all versions
      }

      // Get replication info
      let replication: PostgresMetrics['replication'] | undefined;
      try {
        // Check if this is a replica
        const isReplicaResult = await client.query(`
          SELECT pg_is_in_recovery() as is_replica
        `);
        const isReplica = isReplicaResult.rows[0]?.is_replica || false;

        if (isReplica) {
          // Get replica lag
          const lagResult = await client.query(`
            SELECT
              pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) as lag_bytes,
              EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::integer as lag_seconds
          `);
          replication = {
            isReplica: true,
            replayLagBytes: lagResult.rows[0]?.lag_bytes || null,
            replayLagSeconds: lagResult.rows[0]?.lag_seconds || null,
            state: 'streaming',
          };
        } else {
          // Check for connected replicas
          const replicasResult = await client.query(`
            SELECT count(*) as count, state
            FROM pg_stat_replication
            GROUP BY state
          `);
          if (replicasResult.rows.length > 0) {
            replication = {
              isReplica: false,
              replayLagBytes: null,
              replayLagSeconds: null,
              state: `primary (${replicasResult.rows.length} replicas)`,
            };
          }
        }
      } catch {
        // Replication functions might not be available
      }

      // Get table health summary
      let tableHealth: PostgresMetrics['tableHealth'] | undefined;
      try {
        const tableHealthResult = await client.query(`
          SELECT
            count(*) as total_tables,
            sum(n_dead_tup) as total_dead_tuples,
            count(*) FILTER (WHERE n_dead_tup > 10000) as tables_needing_vacuum
          FROM pg_stat_user_tables
        `);
        const th = tableHealthResult.rows[0];
        if (th) {
          tableHealth = {
            totalTables: parseInt(th.total_tables) || 0,
            totalDeadTuples: parseInt(th.total_dead_tuples) || 0,
            tablesNeedingVacuum: parseInt(th.tables_needing_vacuum) || 0,
          };
        }
      } catch {
        // pg_stat_user_tables might not be accessible
      }

      // Get long running queries (> 30 seconds)
      const longQueriesResult = await client.query(`
        SELECT
          pid,
          now() - pg_stat_activity.query_start as duration,
          state,
          LEFT(query, 200) as query
        FROM pg_stat_activity
        WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
          AND state != 'idle'
          AND datname = current_database()
        ORDER BY duration DESC
        LIMIT 10
      `);
      const longRunningQueries = longQueriesResult.rows.map((row) => ({
        pid: row.pid,
        duration: row.duration?.toString() || 'unknown',
        state: row.state || 'unknown',
        query: row.query || '',
      }));

      return {
        // Essential
        activeConnections,
        idleConnections,
        maxConnections,
        connectionUsagePercent: (totalConnections / maxConnections) * 100,
        databaseSizeBytes,
        cacheHitRatio,
        transactionsCommitted: parseInt(dbStats.xact_commit) || 0,
        transactionsRolledBack: parseInt(dbStats.xact_rollback) || 0,

        // Performance
        tuplesReturned: parseInt(dbStats.tup_returned) || 0,
        tuplesFetched: parseInt(dbStats.tup_fetched) || 0,
        tuplesInserted: parseInt(dbStats.tup_inserted) || 0,
        tuplesUpdated: parseInt(dbStats.tup_updated) || 0,
        tuplesDeleted: parseInt(dbStats.tup_deleted) || 0,
        deadlocks: parseInt(dbStats.deadlocks) || 0,
        tempFilesBytes: parseInt(dbStats.temp_bytes) || 0,
        tempFilesCount: parseInt(dbStats.temp_files) || 0,
        checkpointsWritten: parseInt(bgwriter.checkpoints_timed) || 0,
        checkpointsRequested: parseInt(bgwriter.checkpoints_req) || 0,

        // Replication
        replication,

        // Table health
        tableHealth,

        // Long running queries
        longRunningQueries,

        // Version info
        postgresVersion: version.split(' ').slice(0, 2).join(' '),
        uptimeSeconds,
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
