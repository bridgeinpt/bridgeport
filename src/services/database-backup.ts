import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { SSHClient, LocalClient, isLocalhost, shellEscape, type CommandClient, type LocalExecOptions } from '../lib/ssh.js';
import { getEnvironmentSshKey, getEnvironmentSpacesConfig } from '../routes/environments.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';
import { emitWebhookEvent } from './webhook-subscriptions.js';
import { safeJsonParse, getErrorMessage } from '../lib/helpers.js';
import { getSystemSettings } from './system-settings.js';
import { logAudit } from './audit.js';

// Default pg_dump timeout (5 minutes)
const DEFAULT_PG_DUMP_TIMEOUT_MS = 300000;

// Grace margin added to a database's pg_dump timeout before an in_progress
// backup is considered "stuck" and force-marked failed (see markStuckBackupsFailed).
const STUCK_BACKUP_GRACE_MS = 5 * 60 * 1000; // 5 minutes

export type BackupStep = 'connect' | 'dump' | 'upload';

export interface BackupError {
  message: string;
  step: BackupStep;
  stderr?: string;
  exitCode?: number;
}

export interface PgDumpOptions {
  noOwner?: boolean;
  clean?: boolean;
  ifExists?: boolean;
  schemaOnly?: boolean;
  dataOnly?: boolean;
}

export interface DatabaseInput {
  name: string;
  type: string;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  password?: string;
  filePath?: string;
  useSsl?: boolean;
  serverId?: string;
  backupStorageType?: 'local' | 'spaces';
  backupLocalPath?: string;
  backupSpacesBucket?: string;
  backupSpacesPrefix?: string;
  backupFormat?: 'plain' | 'custom' | 'tar';
  backupCompression?: 'none' | 'gzip';
  backupCompressionLevel?: number;
  pgDumpOptions?: PgDumpOptions;
  pgDumpTimeoutMs?: number;
}

export interface LastBackupInfo {
  id: string;
  status: string;
  type: string;
  createdAt: Date;
  completedAt: Date | null;
  error: string | null;
}

export interface ScheduleInfo {
  enabled: boolean;
  cronExpression: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

export interface DatabaseTypeInfo {
  id: string;
  name: string;
  displayName: string;
  hasBackupCommand: boolean;
}

export interface DatabaseOutput {
  id: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  hasCredentials: boolean;
  filePath: string | null;
  useSsl: boolean;
  serverId: string | null;
  databaseTypeId: string | null;
  databaseType: DatabaseTypeInfo | null;
  backupStorageType: string;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  backupFormat: string;
  backupCompression: string;
  backupCompressionLevel: number;
  pgDumpOptions: PgDumpOptions | null;
  pgDumpTimeoutMs: number;
  monitoringEnabled: boolean;
  collectionIntervalSec: number;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { backups: number; services: number };
  lastBackup?: LastBackupInfo | null;
  schedule?: ScheduleInfo | null;
}

export async function createDatabase(
  environmentId: string,
  input: DatabaseInput,
  databaseTypeId?: string
): Promise<DatabaseOutput> {
  const data: {
    name: string;
    type: string;
    host?: string;
    port?: number;
    databaseName?: string;
    encryptedCredentials?: string;
    credentialsNonce?: string;
    filePath?: string;
    useSsl?: boolean;
    serverId?: string;
    databaseTypeId?: string;
    backupStorageType: string;
    backupLocalPath?: string;
    backupSpacesBucket?: string;
    backupSpacesPrefix?: string;
    backupFormat: string;
    backupCompression: string;
    backupCompressionLevel: number;
    pgDumpOptions?: string;
    pgDumpTimeoutMs?: number;
    environmentId: string;
  } = {
    name: input.name,
    type: input.type,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    filePath: input.filePath,
    useSsl: input.useSsl,
    serverId: input.serverId,
    databaseTypeId,
    backupStorageType: input.backupStorageType || 'local',
    backupLocalPath: input.backupLocalPath,
    backupSpacesBucket: input.backupSpacesBucket,
    backupSpacesPrefix: input.backupSpacesPrefix,
    backupFormat: input.backupFormat || 'plain',
    backupCompression: input.backupCompression || 'none',
    backupCompressionLevel: input.backupCompressionLevel || 6,
    pgDumpTimeoutMs: input.pgDumpTimeoutMs,
    environmentId,
  };

  // Generate default Spaces prefix: {environment}/{name}/
  if (data.backupStorageType === 'spaces' && !data.backupSpacesPrefix) {
    const env = await prisma.environment.findUnique({ where: { id: environmentId }, select: { name: true } });
    if (env) {
      data.backupSpacesPrefix = `${env.name}/${input.name}/`;
    }
  }

  if (input.pgDumpOptions) {
    data.pgDumpOptions = JSON.stringify(input.pgDumpOptions);
  }

  if (input.username && input.password) {
    const credentials = `${input.username}:${input.password}`;
    const { ciphertext, nonce } = encrypt(credentials);
    data.encryptedCredentials = ciphertext;
    data.credentialsNonce = nonce;
  }

  const db = await prisma.database.create({
    data,
    include: {
      _count: { select: { backups: true, services: true } },
      databaseType: { select: { id: true, name: true, displayName: true, backupCommand: true } },
    },
  });

  return toOutput(db);
}

export async function updateDatabase(
  id: string,
  input: Partial<DatabaseInput>
): Promise<DatabaseOutput> {
  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.type !== undefined) data.type = input.type;
  if (input.host !== undefined) data.host = input.host;
  if (input.port !== undefined) data.port = input.port;
  if (input.databaseName !== undefined) data.databaseName = input.databaseName;
  if (input.filePath !== undefined) data.filePath = input.filePath;
  if (input.useSsl !== undefined) data.useSsl = input.useSsl;
  if (input.serverId !== undefined) data.serverId = input.serverId;
  if (input.backupStorageType !== undefined) data.backupStorageType = input.backupStorageType;
  if (input.backupLocalPath !== undefined) data.backupLocalPath = input.backupLocalPath;
  if (input.backupSpacesBucket !== undefined) data.backupSpacesBucket = input.backupSpacesBucket;
  if (input.backupSpacesPrefix !== undefined) data.backupSpacesPrefix = input.backupSpacesPrefix;
  if (input.backupFormat !== undefined) data.backupFormat = input.backupFormat;
  if (input.backupCompression !== undefined) data.backupCompression = input.backupCompression;
  if (input.backupCompressionLevel !== undefined) data.backupCompressionLevel = input.backupCompressionLevel;
  if (input.pgDumpOptions !== undefined) data.pgDumpOptions = JSON.stringify(input.pgDumpOptions);
  if (input.pgDumpTimeoutMs !== undefined) data.pgDumpTimeoutMs = input.pgDumpTimeoutMs;

  if (input.username !== undefined && input.password !== undefined) {
    if (input.username && input.password) {
      const credentials = `${input.username}:${input.password}`;
      const { ciphertext, nonce } = encrypt(credentials);
      data.encryptedCredentials = ciphertext;
      data.credentialsNonce = nonce;
    } else {
      data.encryptedCredentials = null;
      data.credentialsNonce = null;
    }
  }

  const db = await prisma.database.update({
    where: { id },
    data,
    include: {
      _count: { select: { backups: true, services: true } },
      databaseType: { select: { id: true, name: true, displayName: true, backupCommand: true } },
    },
  });

  return toOutput(db);
}

export async function getDatabase(id: string): Promise<DatabaseOutput | null> {
  const db = await prisma.database.findUnique({
    where: { id },
    include: {
      _count: { select: { backups: true, services: true } },
      databaseType: { select: { id: true, name: true, displayName: true, backupCommand: true } },
    },
  });

  return db ? toOutput(db) : null;
}

export async function listDatabases(
  environmentId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ databases: DatabaseOutput[]; total: number }> {
  const limit = options?.limit ?? 25;
  const offset = options?.offset ?? 0;
  const where = { environmentId };

  const [dbs, total] = await Promise.all([
    prisma.database.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
      include: {
        _count: { select: { backups: true, services: true } },
        databaseType: { select: { id: true, name: true, displayName: true, backupCommand: true } },
        backups: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            type: true,
            createdAt: true,
            completedAt: true,
            error: true,
          },
        },
        schedule: {
          select: {
            enabled: true,
            cronExpression: true,
            lastRunAt: true,
            nextRunAt: true,
          },
        },
      },
    }),
    prisma.database.count({ where }),
  ]);

  const databases = dbs.map((db) => {
    const output = toOutput(db);
    output.lastBackup = db.backups[0] || null;
    output.schedule = db.schedule || null;
    return output;
  });

  return { databases, total };
}

export async function deleteDatabase(id: string): Promise<void> {
  await prisma.database.delete({ where: { id } });
}

export interface DatabaseBackupSummaryItem {
  databaseId: string;
  name: string;
  supportsBackup: boolean;
  lastBackup: {
    id: string;
    completedAt: Date | null;
    createdAt: Date;
    status: string;
  } | null;
  schedule: { enabled: boolean; nextRunAt: Date | null } | null;
}

/**
 * Return one row per database in the environment with the last completed
 * backup and the schedule's enabled/nextRunAt. One query — replaces the
 * dashboard's per-database N+1 fan-out (listDatabaseBackups + getBackupSchedule)
 * by leveraging the `(databaseId, createdAt desc)` index on DatabaseBackup.
 */
export async function listEnvironmentBackupSummary(
  environmentId: string
): Promise<DatabaseBackupSummaryItem[]> {
  const databases = await prisma.database.findMany({
    where: { environmentId },
    orderBy: { name: 'asc' },
    include: {
      databaseType: { select: { backupCommand: true } },
      schedule: { select: { enabled: true, nextRunAt: true } },
      backups: {
        where: { status: 'completed' },
        // Order by completedAt (not createdAt) — for the "last completed backup"
        // we want the one that finished most recently, which can differ from
        // createdAt order when a slower earlier run finishes after a later one.
        // Loses the (databaseId, createdAt desc) index optimization, but with
        // take=1 and modest per-DB history this is acceptable.
        orderBy: { completedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          completedAt: true,
          createdAt: true,
          status: true,
        },
      },
    },
  });

  return databases.map((db) => ({
    databaseId: db.id,
    name: db.name,
    supportsBackup: !!db.databaseType?.backupCommand,
    lastBackup: db.backups[0] || null,
    schedule: db.schedule,
  }));
}

function toOutput(db: {
  id: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  encryptedCredentials: string | null;
  filePath: string | null;
  useSsl: boolean;
  serverId: string | null;
  databaseTypeId: string | null;
  databaseType?: { id: string; name: string; displayName: string; backupCommand: string | null } | null;
  backupStorageType: string;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  backupFormat: string;
  backupCompression: string;
  backupCompressionLevel: number;
  pgDumpOptions: string | null;
  pgDumpTimeoutMs: number;
  monitoringEnabled: boolean;
  collectionIntervalSec: number;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { backups: number; services: number };
}): DatabaseOutput {
  const parsedPgDumpOptions: PgDumpOptions | null = db.pgDumpOptions
    ? safeJsonParse(db.pgDumpOptions, {} as PgDumpOptions)
    : null;
  return {
    id: db.id,
    name: db.name,
    type: db.type,
    host: db.host,
    port: db.port,
    databaseName: db.databaseName,
    hasCredentials: !!db.encryptedCredentials,
    filePath: db.filePath,
    useSsl: db.useSsl,
    serverId: db.serverId,
    databaseTypeId: db.databaseTypeId,
    databaseType: db.databaseType ? {
      id: db.databaseType.id,
      name: db.databaseType.name,
      displayName: db.databaseType.displayName,
      hasBackupCommand: !!db.databaseType.backupCommand,
    } : null,
    backupStorageType: db.backupStorageType,
    backupLocalPath: db.backupLocalPath,
    backupSpacesBucket: db.backupSpacesBucket,
    backupSpacesPrefix: db.backupSpacesPrefix,
    backupFormat: db.backupFormat,
    backupCompression: db.backupCompression,
    backupCompressionLevel: db.backupCompressionLevel,
    pgDumpOptions: parsedPgDumpOptions,
    pgDumpTimeoutMs: db.pgDumpTimeoutMs,
    monitoringEnabled: db.monitoringEnabled,
    collectionIntervalSec: db.collectionIntervalSec,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
    environmentId: db.environmentId,
    _count: db._count,
  };
}

export async function createBackup(
  databaseId: string,
  triggeredById: string | null,
  type: 'manual' | 'scheduled' = 'manual'
): Promise<{ backupId: string }> {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: { environment: true, server: true },
  });

  if (!db) throw new Error('Database not found');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Generate filename with appropriate extension based on format and compression
  let extension = '.sql';
  if (db.backupFormat === 'custom') {
    extension = '.dump';
  } else if (db.backupFormat === 'tar') {
    extension = '.tar';
  }
  // Add gzip extension if using external compression (plain format)
  if (db.backupCompression === 'gzip' && db.backupFormat === 'plain') {
    extension += '.gz';
  }
  const filename = `${db.name}-${timestamp}${extension}`;

  const backup = await prisma.databaseBackup.create({
    data: {
      filename,
      size: BigInt(0),
      type,
      status: 'pending',
      storageType: db.backupStorageType,
      storagePath: db.backupStorageType === 'local'
        ? `${db.backupLocalPath || '/var/backups'}/${filename}`
        : `${db.backupSpacesPrefix || ''}${filename}`,
      databaseId,
      triggeredById: triggeredById || undefined,
      progress: 0,
    },
  });

  // Execute backup in background (simplified - in production would use a job queue)
  executeBackup(backup.id).catch((err) => {
    console.error(`Backup ${backup.id} failed:`, err);
  });

  return { backupId: backup.id };
}

async function executeBackup(backupId: string): Promise<void> {
  const startTime = Date.now();
  const backup = await prisma.databaseBackup.update({
    where: { id: backupId },
    data: { status: 'in_progress', progress: 10 },
    include: {
      database: {
        include: { environment: true, server: true, databaseType: true },
      },
    },
  });

  const db = backup.database;
  const useSpaces = db.backupStorageType === 'spaces';

  // Parse pg_dump options
  const pgOpts: PgDumpOptions = db.pgDumpOptions
    ? safeJsonParse(db.pgDumpOptions, {} as PgDumpOptions)
    : {};

  // Determine file extension for temp file
  let tempExtension = '.sql';
  if (db.backupFormat === 'custom') {
    tempExtension = '.dump';
  } else if (db.backupFormat === 'tar') {
    tempExtension = '.tar';
  }
  if (db.backupCompression === 'gzip' && db.backupFormat === 'plain') {
    tempExtension += '.gz';
  }

  // For Spaces, dump to temp file first; for local, dump to final path
  const tempPath = useSpaces ? join(tmpdir(), `backup-${backupId}${tempExtension}`) : null;
  // For SQLite + Spaces, we dump on server then download; track server temp path
  let sqliteServerTempPath: string | null = null;
  const targetPath = tempPath || backup.storagePath;

  let currentStep: BackupStep = 'connect';

  try {
    let dumpCommand = '';
    let client: CommandClient;
    let password = '';
    let execOptions: LocalExecOptions | undefined;

    // Decrypt credentials if available
    let username = '';
    if (db.encryptedCredentials && db.credentialsNonce) {
      const creds = decrypt(db.encryptedCredentials, db.credentialsNonce);
      [username, password] = creds.split(':');
    }

    // Check for template-based backup command from DatabaseType
    const backupTemplate = db.databaseType?.backupCommand;

    if (backupTemplate) {
      // Template-based backup: substitute placeholders
      const vars: Record<string, string> = {
        host: db.host || 'localhost',
        port: String(db.port || ''),
        databaseName: db.databaseName || '',
        username,
        password,
        filePath: db.filePath || '',
        outputFile: targetPath,
      };
      dumpCommand = backupTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');

      // Determine client based on whether we need SSH
      if (db.server && !isLocalhost(db.server.hostname)) {
        const sshCreds = await getEnvironmentSshKey(db.environmentId);
        if (!sshCreds) {
          throw new Error('SSH key not configured for this environment');
        }
        client = new SSHClient({
          hostname: db.server.hostname,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        });
      } else {
        client = new LocalClient();
      }

      // Set PGPASSWORD env for postgres-compatible templates
      if (password && (db.type === 'postgres' || dumpCommand.includes('pg_dump') || dumpCommand.includes('psql'))) {
        execOptions = { env: { PGPASSWORD: password, PGSSLMODE: 'require' }, timeout: db.pgDumpTimeoutMs || DEFAULT_PG_DUMP_TIMEOUT_MS };
      }
    } else if (db.type === 'postgres' && db.host) {
      // Postgres: run pg_dump locally (connects remotely to database)
      client = new LocalClient();

      // Build pg_dump command with format and options
      const cmdParts = ['pg_dump', '--no-password'];

      // Format flag
      if (db.backupFormat === 'custom') {
        cmdParts.push('-Fc'); // custom format (includes compression)
      } else if (db.backupFormat === 'tar') {
        cmdParts.push('-Ft'); // tar format
      } else {
        cmdParts.push('-Fp'); // plain text format
      }

      // pg_dump options
      if (pgOpts.noOwner) cmdParts.push('--no-owner');
      if (pgOpts.clean) cmdParts.push('--clean');
      if (pgOpts.ifExists) cmdParts.push('--if-exists');
      if (pgOpts.schemaOnly) cmdParts.push('--schema-only');
      if (pgOpts.dataOnly) cmdParts.push('--data-only');

      // Connection options
      cmdParts.push(`-h ${db.host}`);
      cmdParts.push(`-p ${db.port || 5432}`);
      cmdParts.push(`-U ${username}`);
      cmdParts.push(`-d ${db.databaseName}`);

      // Output file or pipe through gzip
      if (db.backupCompression === 'gzip' && db.backupFormat === 'plain') {
        // Pipe through gzip for plain format
        cmdParts.push(`| gzip -${db.backupCompressionLevel} > "${targetPath}"`);
      } else {
        cmdParts.push(`-f "${targetPath}"`);
      }

      // Use 2>&1 to capture stderr in stdout so we get better error messages
      dumpCommand = cmdParts.join(' ') + ' 2>&1';
      // Use per-database timeout setting
      execOptions = { env: { PGPASSWORD: password, PGSSLMODE: 'require' }, timeout: db.pgDumpTimeoutMs || DEFAULT_PG_DUMP_TIMEOUT_MS };
    } else if (db.type === 'sqlite' && db.filePath) {
      if (!db.server) {
        throw new Error('SQLite databases require a server to be configured');
      }

      if (isLocalhost(db.server.hostname)) {
        client = new LocalClient();
      } else {
        const sshCreds = await getEnvironmentSshKey(db.environmentId);
        if (!sshCreds) {
          throw new Error('SSH key not configured for this environment');
        }
        client = new SSHClient({
          hostname: db.server.hostname,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        });
      }

      // For SQLite with Spaces, dump to temp on server, then we'll download and upload
      let sqliteDumpPath: string;
      if (useSpaces) {
        sqliteServerTempPath = `/tmp/backup-${backupId}${tempExtension}`;
        sqliteDumpPath = sqliteServerTempPath;
      } else {
        sqliteDumpPath = targetPath;
      }

      // SQLite compression support
      // IMPORTANT: sqlite3 silently creates an empty database if the file doesn't exist,
      // so we must verify the file exists first to avoid creating empty backups
      if (db.backupCompression === 'gzip') {
        dumpCommand = `test -f "${db.filePath}" && sqlite3 "${db.filePath}" ".dump" | gzip -${db.backupCompressionLevel} > "${sqliteDumpPath}" || (echo "Database file not found: ${db.filePath}" >&2 && exit 1)`;
      } else {
        dumpCommand = `test -f "${db.filePath}" && sqlite3 "${db.filePath}" ".dump" > "${sqliteDumpPath}" || (echo "Database file not found: ${db.filePath}" >&2 && exit 1)`;
      }
    } else {
      throw new Error(`Unsupported database type or missing configuration: ${db.type}`);
    }

    await client.connect();
    currentStep = 'dump';

    // Update progress: connected
    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: { progress: 30 },
    });

    // Ensure backup directory exists (for local storage)
    if (!useSpaces) {
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      await client.exec(`mkdir -p ${shellEscape(targetDir)}`);
    }

    const result = await client.exec(dumpCommand, execOptions);
    if (result.code !== 0) {
      // With 2>&1, errors are in stdout; also check stderr as fallback
      const errorOutput = result.stdout || result.stderr || 'Backup command failed (no output)';
      const error: BackupError = {
        message: errorOutput,
        step: 'dump',
        stderr: errorOutput,
        exitCode: result.code,
      };
      throw error;
    }

    // Update progress: dump complete
    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: { progress: 70 },
    });

    // Get file size (use server temp path for SQLite + Spaces)
    const sizeCheckPath = sqliteServerTempPath || targetPath;
    const sizeResult = await client.exec(`stat -c %s ${shellEscape(sizeCheckPath)} 2>/dev/null || stat -f %z ${shellEscape(sizeCheckPath)}`);
    const size = parseInt(sizeResult.stdout.trim()) || 0;

    // For SQLite + Spaces, download the dump from server before disconnecting
    if (sqliteServerTempPath && tempPath) {
      // Check if server and local paths are the same (localhost case)
      const isLocalExecution = client instanceof LocalClient;

      if (isLocalExecution && sqliteServerTempPath === tempPath) {
        // Paths are the same on localhost - file is already in place, no need to download
        // Don't delete since we need it for S3 upload
      } else {
        const downloadResult = await client.exec(`cat ${shellEscape(sqliteServerTempPath)} | base64`);
        if (downloadResult.code !== 0) {
          throw new Error(`Failed to download backup from server: ${downloadResult.stderr}`);
        }
        const fileContent = Buffer.from(downloadResult.stdout.trim(), 'base64');
        const { writeFile } = await import('fs/promises');
        await writeFile(tempPath, fileContent);
        // Clean up server temp file (only if different from local temp)
        await client.exec(`rm -f ${shellEscape(sqliteServerTempPath)}`);
      }
    }

    client.disconnect();

    // Upload to Spaces if configured
    if (useSpaces && tempPath) {
      currentStep = 'upload';

      // Update progress: starting upload
      await prisma.databaseBackup.update({
        where: { id: backupId },
        data: { progress: 80 },
      });

      const spacesConfig = await getEnvironmentSpacesConfig(db.environmentId);
      if (!spacesConfig) {
        throw new Error('Spaces not configured for this environment. Go to Settings > Spaces to configure.');
      }

      if (!db.backupSpacesBucket) {
        throw new Error('No Spaces bucket configured for this database');
      }

      const s3Client = new S3Client({
        endpoint: `https://${spacesConfig.endpoint}`,
        region: spacesConfig.region,
        credentials: {
          accessKeyId: spacesConfig.accessKey,
          secretAccessKey: spacesConfig.secretKey,
        },
      });

      const fileContent = await readFile(tempPath);
      const spacesKey = backup.storagePath; // Already includes prefix + filename

      // Determine content type
      let contentType = 'application/sql';
      if (db.backupFormat === 'custom') {
        contentType = 'application/octet-stream';
      } else if (db.backupFormat === 'tar') {
        contentType = 'application/x-tar';
      } else if (db.backupCompression === 'gzip') {
        contentType = 'application/gzip';
      }

      await s3Client.send(new PutObjectCommand({
        Bucket: db.backupSpacesBucket,
        Key: spacesKey,
        Body: fileContent,
        ContentType: contentType,
      }));

      // Clean up temp file
      await unlink(tempPath).catch(() => {});
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: {
        status: 'completed',
        size: BigInt(size),
        progress: 100,
        duration,
        completedAt: new Date(),
      },
    });

    // Send success notification
    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_BACKUP_SUCCESS,
      db.environmentId,
      { databaseName: db.name }
    );

    // Fire-and-forget webhook event (issue #126). emitWebhookEvent never throws.
    void emitWebhookEvent('backup.completed', db.environmentId, {
      backupId,
      databaseId: db.id,
      databaseName: db.name,
      success: true,
      status: 'completed',
    });
  } catch (error) {
    // Clean up temp file on error
    if (tempPath) {
      await unlink(tempPath).catch(() => {});
    }

    // Build structured error
    let backupError: BackupError;
    if (error && typeof error === 'object' && 'step' in error) {
      // Already a BackupError
      backupError = error as BackupError;
    } else {
      backupError = {
        message: error instanceof Error ? error.message : 'Unknown error',
        step: currentStep,
      };
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: {
        status: 'failed',
        error: JSON.stringify(backupError),
        duration,
        completedAt: new Date(),
      },
    });

    // Send failure notification
    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_BACKUP_FAILED,
      db.environmentId,
      {
        databaseName: db.name,
        error: backupError.message,
        step: backupError.step,
      }
    );

    // Fire-and-forget webhook event (issue #126). emitWebhookEvent never throws.
    void emitWebhookEvent('backup.failed', db.environmentId, {
      backupId,
      databaseId: db.id,
      databaseName: db.name,
      success: false,
      status: 'failed',
      error: backupError.message,
    });

    throw error;
  }
}

export interface BackupListOptions {
  limit?: number;
  offset?: number;
}

export async function listBackups(databaseId: string, options: BackupListOptions = {}) {
  const { limit = 50, offset = 0 } = options;
  const [backups, total] = await Promise.all([
    prisma.databaseBackup.findMany({
      where: { databaseId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        triggeredBy: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.databaseBackup.count({ where: { databaseId } }),
  ]);
  return { backups, total };
}

export async function getBackup(id: string) {
  return prisma.databaseBackup.findUnique({
    where: { id },
    include: {
      database: { include: { server: true, environment: true } },
      triggeredBy: { select: { id: true, email: true, name: true } },
    },
  });
}

// Minimal shape needed to locate + delete a backup's physical artifact.
// Loaded via `include: { database: { include: { server: true } } }`.
type BackupWithStorage = {
  id: string;
  storageType: string;
  storagePath: string;
  database: {
    environmentId: string;
    backupSpacesBucket: string | null;
    server: { hostname: string } | null;
  };
};

/**
 * Delete the physical artifact for a backup (file-first deletion, §6.6).
 *
 * Idempotent: a missing file (`rm -f` always exits 0) or a Spaces 404 /
 * NoSuchKey counts as success, so retries after a partial failure are safe.
 * Returns `{ ok: false, error }` on a *real* failure (unreachable host, S3
 * error other than not-found) instead of swallowing it, so the caller can
 * keep the DB row and retry rather than orphaning the file.
 *
 * Note this does NOT delete the DatabaseBackup row — callers
 * (`deleteBackup`, `pruneBackup`, `cleanupFailedBackups`) decide row deletion
 * based on the result.
 */
async function deleteBackupArtifact(
  backup: BackupWithStorage
): Promise<{ ok: boolean; error?: string }> {
  if (backup.storageType === 'local') {
    if (!backup.database.server) {
      // No server to reach — nothing we can delete. Treat as success so the
      // row can be cleaned up (matches prior behavior of deleting the record).
      return { ok: true };
    }

    let client: CommandClient;
    if (isLocalhost(backup.database.server.hostname)) {
      client = new LocalClient();
    } else {
      const sshCreds = await getEnvironmentSshKey(backup.database.environmentId);
      if (!sshCreds) {
        // Can't reach the file without SSH credentials. Surface this so the
        // caller doesn't silently orphan it.
        return { ok: false, error: 'SSH key not configured for this environment' };
      }
      client = new SSHClient({
        hostname: backup.database.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });
    }

    try {
      await client.connect();
      // `rm -f` exits 0 even if the file is already gone → idempotent.
      const result = await client.exec(`rm -f -- ${shellEscape(backup.storagePath)}`);
      client.disconnect();
      if (result.code !== 0) {
        return { ok: false, error: result.stderr || result.stdout || `rm exited ${result.code}` };
      }
      return { ok: true };
    } catch (error) {
      try { client.disconnect(); } catch { /* best-effort */ }
      return { ok: false, error: getErrorMessage(error, 'Failed to delete backup file') };
    }
  }

  if (backup.storageType === 'spaces' && backup.database.backupSpacesBucket) {
    try {
      const spacesConfig = await getEnvironmentSpacesConfig(backup.database.environmentId);
      if (!spacesConfig) {
        // No Spaces config to reach the object — surface rather than orphan.
        return { ok: false, error: 'Spaces not configured for this environment' };
      }
      const s3Client = new S3Client({
        endpoint: `https://${spacesConfig.endpoint}`,
        region: spacesConfig.region,
        credentials: {
          accessKeyId: spacesConfig.accessKey,
          secretAccessKey: spacesConfig.secretKey,
        },
      });
      await s3Client.send(new DeleteObjectCommand({
        Bucket: backup.database.backupSpacesBucket,
        Key: backup.storagePath,
      }));
      return { ok: true };
    } catch (error) {
      // A missing object is success (idempotent). S3 surfaces this as
      // NoSuchKey or a 404 $metadata status.
      if (isNotFoundError(error)) {
        return { ok: true };
      }
      return { ok: false, error: getErrorMessage(error, 'Failed to delete backup object') };
    }
  }

  // No recognized storage backend / nothing to delete.
  return { ok: true };
}

/** True for S3 "object does not exist" errors (treated as idempotent success). */
function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/**
 * Delete a backup (user-initiated). File-first: try to delete the physical
 * artifact, then ALWAYS delete the DB row (§6.6 / decision #4).
 *
 * Unlike the automated `pruneBackup` (which keeps the row + records
 * `lastRotationError` + retries on the next sweep), an explicit user delete
 * must always succeed: if the artifact can't be removed (host down, missing
 * SSH key, Spaces removed) we log the orphaned file loudly via `console.warn`
 * and still drop the row, so the user is never left with an undeletable
 * backup. Preserves the original `Promise<void>` contract.
 */
export async function deleteBackup(id: string): Promise<void> {
  const backup = await prisma.databaseBackup.findUnique({
    where: { id },
    include: { database: { include: { server: true } } },
  });

  if (!backup) throw new Error('Backup not found');

  const result = await deleteBackupArtifact(backup);
  if (!result.ok) {
    // User-initiated delete: don't strand the row. Warn about the orphaned
    // artifact (non-silent) and still remove the record.
    console.warn(
      `[Backup] Could not delete artifact for backup ${id} (${backup.storageType}: ${backup.storagePath}): ` +
      `${result.error ?? 'unknown error'}. Removing the database row anyway; the file may be orphaned.`
    );
  }

  await prisma.databaseBackup.delete({ where: { id } });
}

export async function setBackupSchedule(
  databaseId: string,
  cronExpression: string,
  retentionDays: number = 7,
  enabled: boolean = true
) {
  const nextRunAt = enabled ? getNextRunTime(cronExpression, new Date()) : null;
  return prisma.backupSchedule.upsert({
    where: { databaseId },
    update: { cronExpression, retentionDays, enabled, nextRunAt },
    create: { databaseId, cronExpression, retentionDays, enabled, nextRunAt },
  });
}

export async function getBackupSchedule(databaseId: string) {
  return prisma.backupSchedule.findUnique({ where: { databaseId } });
}

export async function deleteBackupSchedule(databaseId: string) {
  await prisma.backupSchedule.delete({ where: { databaseId } }).catch(() => {});
}

/**
 * Generate a download URL or stream for a backup.
 * Returns either a presigned URL (for Spaces) or file content (for local).
 */
export async function getBackupDownload(
  backupId: string
): Promise<{ type: 'url'; url: string } | { type: 'stream'; filename: string; content: Buffer }> {
  const backup = await prisma.databaseBackup.findUnique({
    where: { id: backupId },
    include: {
      database: { include: { server: true } },
    },
  });

  if (!backup) throw new Error('Backup not found');
  if (backup.status !== 'completed') throw new Error('Backup is not completed');

  // Check if downloads are allowed
  const dataSettings = await prisma.dataSettings.findUnique({
    where: { environmentId: backup.database.environmentId },
  });
  if (!dataSettings?.allowBackupDownload) {
    throw new Error('Backup downloads are not allowed for this environment');
  }

  if (backup.storageType === 'spaces') {
    // Generate presigned URL for Spaces
    const spacesConfig = await getEnvironmentSpacesConfig(backup.database.environmentId);
    if (!spacesConfig) {
      throw new Error('Spaces not configured for this environment');
    }

    if (!backup.database.backupSpacesBucket) {
      throw new Error('No Spaces bucket configured for this database');
    }

    const s3Client = new S3Client({
      endpoint: `https://${spacesConfig.endpoint}`,
      region: spacesConfig.region,
      credentials: {
        accessKeyId: spacesConfig.accessKey,
        secretAccessKey: spacesConfig.secretKey,
      },
    });

    const command = new GetObjectCommand({
      Bucket: backup.database.backupSpacesBucket,
      Key: backup.storagePath,
      ResponseContentDisposition: `attachment; filename="${backup.filename}"`,
    });

    // Generate presigned URL valid for 1 hour
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return { type: 'url', url };
  } else {
    // Stream from local storage via SSH
    if (!backup.database.server) {
      throw new Error('Database server is not configured');
    }

    let client: CommandClient;
    if (isLocalhost(backup.database.server.hostname)) {
      client = new LocalClient();
    } else {
      const sshCreds = await getEnvironmentSshKey(backup.database.environmentId);
      if (!sshCreds) {
        throw new Error('SSH key not configured for this environment');
      }
      client = new SSHClient({
        hostname: backup.database.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });
    }

    await client.connect();
    const result = await client.exec(`cat ${shellEscape(backup.storagePath)} | base64`);
    client.disconnect();

    if (result.code !== 0) {
      throw new Error(`Failed to read backup file: ${result.stderr}`);
    }

    const content = Buffer.from(result.stdout.trim(), 'base64');
    return { type: 'stream', filename: backup.filename, content };
  }
}

/**
 * Check for due backups and execute them.
 * Called periodically by the scheduler.
 */
export async function checkDueBackups(): Promise<void> {
  const now = new Date();

  // Find schedules that are due
  const schedules = await prisma.backupSchedule.findMany({
    where: { enabled: true },
    include: { database: true },
  });

  for (const schedule of schedules) {
    try {
      // Simple cron check - check if enough time has passed since last run
      const shouldRun = isScheduleDue(schedule.cronExpression, schedule.lastRunAt, now);

      if (shouldRun) {
        console.log(`[Scheduler] Running scheduled backup for database ${schedule.database.name}`);

        // Update lastRunAt before running to prevent duplicate runs
        await prisma.backupSchedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: now, nextRunAt: getNextRunTime(schedule.cronExpression, now) },
        });

        // Create backup (null triggeredById for scheduler-triggered backups)
        await createBackup(schedule.databaseId, null, 'scheduled');

        // Apply GFS retention rotation for this database (replaces the old
        // flat retentionDays cleanup). Wrapped so a rotation failure never
        // aborts the rest of the due-schedule loop.
        await rotateDatabase(schedule.databaseId, { trigger: 'post-backup' });
      }
    } catch (error) {
      console.error(`[Scheduler] Failed to run backup for database ${schedule.database.name}:`, error);
    }
  }
}

/**
 * Parse a cron field into a set of valid values.
 * Supports: wildcard, specific numbers, ranges (1-5), steps, and lists (1,3,5).
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr);
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          [start, end] = range.split('-').map(Number);
        } else {
          start = parseInt(range);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part));
    }
  }
  return values;
}

/**
 * Calculate the next run time for a cron expression after the given date.
 * Standard 5-field cron: minute hour day-of-month month day-of-week
 */
export function getNextRunTime(cronExpression: string, from: Date): Date {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) {
    const fallback = new Date(from);
    fallback.setDate(fallback.getDate() + 1);
    return fallback;
  }

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const daysOfMonth = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const daysOfWeek = parseCronField(parts[4], 0, 7);
  if (daysOfWeek.has(7)) daysOfWeek.add(0); // Normalize Sunday

  const hasDomConstraint = parts[2] !== '*';
  const hasDowConstraint = parts[4] !== '*';

  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Search up to 1 year ahead
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!months.has(next.getMonth() + 1)) {
      next.setMonth(next.getMonth() + 1, 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }

    // Standard cron: if both dom and dow are restricted, match either (OR).
    // If only one is restricted, the other is treated as * (AND).
    const domMatch = daysOfMonth.has(next.getDate());
    const dowMatch = daysOfWeek.has(next.getDay());
    const dayMatch = (hasDomConstraint && hasDowConstraint)
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);

    if (!dayMatch) {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }

    if (!hours.has(next.getHours())) {
      next.setHours(next.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minutes.has(next.getMinutes())) {
      next.setMinutes(next.getMinutes() + 1, 0, 0);
      continue;
    }

    return next;
  }

  // Fallback
  const fallback = new Date(from);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

/**
 * Check if a cron schedule is due to run.
 * Calculates the next occurrence after lastRunAt and checks if it's <= now.
 */
function isScheduleDue(cronExpression: string, lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true;
  const nextRun = getNextRunTime(cronExpression, lastRunAt);
  return nextRun <= now;
}

// ===========================================================================
// GFS backup rotation & retention (issue #291)
// ===========================================================================

/** A retention policy: GFS tier counts + floor + optional size cap (§4). */
export interface RetentionPolicy {
  keepLast: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
  minFloor: number;
}

/**
 * Named retention presets (§4.1). Selecting a non-`custom` preset fills these
 * fields. `maxTotalBytes` defaults to null (off) in every preset. Exported so
 * the route layer (Slice C) can round-trip preset -> fields.
 */
export const PRESETS: Record<'lean' | 'balanced' | 'long_term', RetentionPolicy> = {
  lean:      { keepLast: 12, daily: 7, weekly: 4, monthly: 0,  yearly: 0, minFloor: 2 },
  balanced:  { keepLast: 24, daily: 7, weekly: 4, monthly: 6,  yearly: 0, minFloor: 2 }, // DEFAULT
  long_term: { keepLast: 24, daily: 7, weekly: 4, monthly: 12, yearly: 3, minFloor: 2 },
};

/**
 * Inclusive bounds for each policy field (§4). Exported so route validation
 * (Slice C) reuses a single source of truth.
 */
export const RETENTION_BOUNDS = {
  keepLast: { min: 0, max: 100 },
  daily:    { min: 0, max: 366 },
  weekly:   { min: 0, max: 520 },
  monthly:  { min: 0, max: 240 },
  yearly:   { min: 0, max: 50 },
  minFloor: { min: 1, max: 10 },
} as const;

/** Period granularity for tier bucketing. */
export type Period = 'day' | 'week' | 'month' | 'year';

/**
 * Minimal shape the pure selection helpers operate on. Both the Prisma
 * `DatabaseBackup` row and plain test objects satisfy it. Kept tiny so the
 * helpers stay unit-testable without Prisma or Date.now.
 */
export interface RotationCandidate {
  id: string;
  createdAt: Date;
  size: bigint;
}

/**
 * Extract the calendar parts of a Date in a given IANA timezone using the
 * built-in Intl APIs (no new dependency). `en-CA` formats as YYYY-MM-DD which
 * is trivially parseable. Returns numeric year/month/day in the target tz.
 */
function tzDateParts(date: Date, tz: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA produces "2026-06-22"
  const [year, month, day] = fmt.format(date).split('-').map((p) => parseInt(p, 10));
  return { year, month, day };
}

/**
 * ISO-8601 week number + ISO week-year for a tz-local calendar date.
 *
 * ISO weeks start Monday and week 1 is the week containing the year's first
 * Thursday. We compute this purely from the Y/M/D (already resolved in the
 * target tz) so DST never shifts a bucket:
 *
 *   1. Take the day-of-week with Monday=1..Sunday=7.
 *   2. Find the Thursday of this week (the ISO "anchor" — its calendar year is
 *      always the ISO week-year). Thursday = current date + (4 - dow) days.
 *   3. Week number = floor((thursday - Jan 1 of thursday's year) / 7 days) + 1.
 *
 * This yields the correct W52/W53/W01 behavior at year boundaries because the
 * Thursday's year, not the original date's year, defines the week-year.
 */
function isoWeekKey(year: number, month: number, day: number): string {
  // Use UTC math purely as a calendar calculator (no tz semantics here — the
  // Y/M/D already came from the target tz). 1=Mon..7=Sun.
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  // Shift to the Thursday of the current ISO week.
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - dow));
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Calendar bucket key for a date, computed IN `tz` (§6.2). Examples:
 *   day   "2026-06-22"
 *   week  "2026-W26"  (ISO week, starts Monday)
 *   month "2026-06"
 *   year  "2026"
 */
export function periodKey(date: Date, period: Period, tz: string): string {
  const { year, month, day } = tzDateParts(date, tz);
  switch (period) {
    case 'day':
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    case 'week':
      return isoWeekKey(year, month, day);
    case 'month':
      return `${year}-${String(month).padStart(2, '0')}`;
    case 'year':
      return `${year}`;
  }
}

/**
 * Select the newest-by-createdAt backup in each of the `count` most-recent
 * buckets that exist among the candidates (§6.2). Buckets are relative to the
 * candidates' OWN distinct keys (sortDesc then slice), not "now" — matching
 * restic/borg semantics. `count <= 0` returns an empty set.
 *
 * Pure: no Prisma, no Date.now.
 */
export function selectPeriodTier<T extends RotationCandidate>(
  candidates: T[],
  period: Period,
  count: number,
  tz: string
): Set<string> {
  const selected = new Set<string>();
  if (count <= 0) return selected;

  // Group candidates by bucket key, tracking the newest in each bucket.
  const newestByBucket = new Map<string, T>();
  for (const c of candidates) {
    const key = periodKey(c.createdAt, period, tz);
    const current = newestByBucket.get(key);
    if (!current || c.createdAt.getTime() > current.createdAt.getTime()) {
      newestByBucket.set(key, c);
    }
  }

  // Take the `count` most-recent buckets (descending by key — keys are
  // lexicographically ordered the same as chronologically for our formats).
  const keys = Array.from(newestByBucket.keys()).sort().reverse().slice(0, count);
  for (const key of keys) {
    selected.add(newestByBucket.get(key)!.id);
  }
  return selected;
}

/**
 * Union of all retention tiers (§6.2): recent (`keepLast` newest) plus the
 * day/week/month/year period tiers. A backup survives if ANY tier selects it.
 * `candidates` need not be pre-sorted; the recent tier sorts internally.
 *
 * Pure: no Prisma, no Date.now.
 */
export function selectKeep<T extends RotationCandidate>(
  candidates: T[],
  policy: RetentionPolicy,
  tz: string
): Set<string> {
  const keep = new Set<string>();

  // Recent tier: the keepLast newest by createdAt.
  const byNewest = [...candidates].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  for (const c of byNewest.slice(0, Math.max(0, policy.keepLast))) {
    keep.add(c.id);
  }

  // Period tiers.
  for (const id of selectPeriodTier(candidates, 'day', policy.daily, tz)) keep.add(id);
  for (const id of selectPeriodTier(candidates, 'week', policy.weekly, tz)) keep.add(id);
  for (const id of selectPeriodTier(candidates, 'month', policy.monthly, tz)) keep.add(id);
  for (const id of selectPeriodTier(candidates, 'year', policy.yearly, tz)) keep.add(id);

  return keep;
}

/**
 * Safety floor (§6.3): ensure the total retained *successful* backups
 * (exempt-successful, e.g. manual/pinned, PLUS the kept candidates) is at
 * least `minFloor`. Pulls the most-recent items out of the prune set back
 * into keep until satisfied. Never prunes below `minFloor` and (with
 * minFloor >= 1) never prunes the only successful backup.
 *
 * Pure: no Prisma, no Date.now.
 */
export function applyFloor<T extends RotationCandidate>(
  candidates: T[],
  keepIds: Set<string>,
  exemptSuccessfulCount: number,
  minFloor: number
): Set<string> {
  const keep = new Set(keepIds);
  // Most-recent-first so we pull back the freshest pruned items first.
  const byNewest = [...candidates].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  for (const c of byNewest) {
    const retained = exemptSuccessfulCount + keep.size;
    if (retained >= minFloor) break;
    keep.add(c.id); // adding an already-kept id is a no-op
  }
  return keep;
}

/**
 * Optional storage-cap eviction (§6.4). Only relevant when `maxTotalBytes`
 * is set. While the total size of ALL the DB's completed backups (including
 * manual & pinned — passed as `exemptSize`) plus the kept prunable candidates
 * exceeds the cap, evict the OLDEST prunable kept item whose removal keeps
 * retained-successful >= minFloor. Manual/pinned are never evicted.
 *
 * Returns the (possibly reduced) keep set and `cappedButUnreachable: true`
 * when the cap still can't be met without touching exempt backups.
 *
 * Pure: no Prisma, no Date.now.
 */
export function applySizeCap<T extends RotationCandidate>(
  candidates: T[],
  keepIds: Set<string>,
  exemptSize: bigint,
  exemptSuccessfulCount: number,
  minFloor: number,
  maxTotalBytes: bigint | null
): { keep: Set<string>; cappedButUnreachable: boolean } {
  const keep = new Set(keepIds);
  if (maxTotalBytes == null) {
    return { keep, cappedButUnreachable: false };
  }

  const sizeById = new Map(candidates.map((c) => [c.id, c.size]));
  let total = exemptSize;
  for (const id of keep) {
    total += sizeById.get(id) ?? BigInt(0);
  }

  // Oldest prunable kept items first (eviction order).
  const keptOldestFirst = candidates
    .filter((c) => keep.has(c.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const victim of keptOldestFirst) {
    if (total <= maxTotalBytes) break;
    // Removing a successful candidate drops retained-successful by 1.
    const retainedAfter = exemptSuccessfulCount + (keep.size - 1);
    if (retainedAfter < minFloor) break; // floor protects this victim
    keep.delete(victim.id);
    total -= victim.size;
  }

  return { keep, cappedButUnreachable: total > maxTotalBytes };
}

/**
 * The fully-resolved retention policy for a database plus provenance.
 */
export interface EffectivePolicy {
  keepLast: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
  minFloor: number;
  maxTotalBytes: bigint | null;
  preset: string;
  source: 'override' | 'inherited';
  // True only for an inert, upgrade-migration-created override (autoApplied row).
  // Automatic rotation skips such policies; an operator save clears it. Always
  // false for the inherited global default. See rotateDatabase.
  autoApplied: boolean;
}

/**
 * Map the instance global-default retention settings to an EffectivePolicy
 * (§4.2). The global default is always an explicit instance setting, so
 * `source: 'inherited'` and `autoApplied: false`. Shared by
 * `resolveRetentionPolicy`'s inherited branch and the route layer's
 * `globalDefaultPolicy` so the mapping lives in exactly one place.
 */
export function globalDefaultPolicyFromSettings(
  settings: Awaited<ReturnType<typeof getSystemSettings>>
): EffectivePolicy {
  return {
    keepLast: settings.backupRetentionKeepLast,
    daily: settings.backupRetentionDaily,
    weekly: settings.backupRetentionWeekly,
    monthly: settings.backupRetentionMonthly,
    yearly: settings.backupRetentionYearly,
    minFloor: settings.backupRetentionMinFloor,
    maxTotalBytes: settings.backupRetentionMaxTotalBytes,
    preset: settings.backupRetentionPreset,
    source: 'inherited',
    autoApplied: false,
  };
}

/**
 * Resolve the effective retention policy for a database (§4.2). Returns the
 * per-database override when one exists and isn't flagged `inheritGlobal`;
 * otherwise the global default from SystemSettings. Always concrete.
 */
export async function resolveRetentionPolicy(databaseId: string): Promise<EffectivePolicy> {
  const override = await prisma.backupRetentionPolicy.findUnique({
    where: { databaseId },
  });

  if (override && !override.inheritGlobal) {
    return {
      keepLast: override.keepLast,
      daily: override.daily,
      weekly: override.weekly,
      monthly: override.monthly,
      yearly: override.yearly,
      minFloor: override.minFloor,
      maxTotalBytes: override.maxTotalBytes,
      preset: override.preset,
      source: 'override',
      autoApplied: override.autoApplied,
    };
  }

  const settings = await getSystemSettings();
  return globalDefaultPolicyFromSettings(settings);
}

/** Result of a rotation pass (§6.7). `bytesFreed` is bigint per repo convention. */
export interface RotationResult {
  keep: string[];
  prune: string[];
  bytesFreed: bigint;
  cappedButUnreachable?: boolean;
  errors?: { backupId: string; error: string }[];
}

/**
 * Prune a single backup: delete the physical artifact first, then the row
 * (§6.6). On artifact-delete failure the row is KEPT, `lastRotationError` is
 * recorded, and `{ ok: false, error }` is returned so the next sweep retries
 * (idempotent: a missing file on retry counts as success). On success the row
 * is deleted. Never throws for an individual backup.
 */
export async function pruneBackup(
  backupId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const backup = await prisma.databaseBackup.findUnique({
    where: { id: backupId },
    include: { database: { include: { server: true } } },
  });

  if (!backup) {
    // Already gone — idempotent success.
    return { ok: true };
  }

  const result = await deleteBackupArtifact(backup);
  if (!result.ok) {
    const error = result.error ?? 'Failed to delete backup file';
    await prisma.databaseBackup
      .update({ where: { id: backupId }, data: { lastRotationError: error } })
      .catch(() => { /* row may have been deleted concurrently */ });
    console.error(`[Rotation] Failed to prune backup ${backupId}: ${error}`);
    return { ok: false, error };
  }

  await prisma.databaseBackup.delete({ where: { id: backupId } });
  return { ok: true };
}

/**
 * Apply GFS rotation to a single database (§6). Replaces the old
 * `enforceRetention`.
 *
 * 1. Load the prunable universe (completed && scheduled && !pinned) and count
 *    exempt-successful (completed manual or pinned) for the floor.
 * 2. keep = selectKeep -> applyFloor -> applySizeCap (using the resolved
 *    policy + instance timezone).
 * 3. prune = candidates - keep.
 * 4. dryRun returns the preview without deleting.
 * 5. Otherwise prune each (file-first via pruneBackup), collecting failures.
 * 6. Audit-log + notify on errors / unreachable cap.
 */
export async function rotateDatabase(
  databaseId: string,
  opts: { dryRun?: boolean; trigger?: string; policy?: EffectivePolicy } = {}
): Promise<RotationResult> {
  const { dryRun = false, trigger = 'manual' } = opts;

  // When a proposed policy is supplied (preview / confirmation gate), evaluate
  // it directly instead of the currently-stored one. Otherwise resolve as usual.
  const [resolvedPolicy, settings] = await Promise.all([
    opts.policy ? Promise.resolve(opts.policy) : resolveRetentionPolicy(databaseId),
    getSystemSettings(),
  ]);
  const policy = resolvedPolicy;
  const tz = settings.timezone || 'UTC';

  // INERT migrated policy guard (issue #291, GOLDEN RULE + spec decision #12).
  // A policy auto-created by the upgrade migration (autoApplied) is a snapshot of
  // legacy flat retention and must NOT cause automatic deletes — a flat
  // "keep N days" and GFS daily=N diverge for sub-daily schedules. So for an
  // AUTOMATIC trigger (sweep / post-backup) using the STORED policy (no explicit
  // opts.policy), skip pruning entirely and keep everything until an operator
  // saves the policy (which clears autoApplied). Explicit triggers (manual,
  // policy-change) and any preview/confirm call with an explicit opts.policy
  // ignore this and rotate normally.
  const isAutomaticTrigger = trigger === 'sweep' || trigger === 'post-backup';
  if (isAutomaticTrigger && policy.autoApplied && !opts.policy) {
    const all = await prisma.databaseBackup.findMany({
      where: { databaseId, status: 'completed', type: 'scheduled', isPinned: false },
      select: { id: true },
    });
    console.log(
      `[Rotation] Skipping database ${databaseId}: inert migrated policy (autoApplied) — ` +
      `automatic pruning paused until an operator saves the retention policy. trigger=${trigger}`
    );
    return { keep: all.map((b) => b.id), prune: [], bytesFreed: BigInt(0) };
  }

  // Prunable universe: completed + scheduled + not pinned. Sorted newest-first.
  // `lastRotationError` is selected so we can clear a stale error on any KEPT
  // row below (a pass that retains it means there's no outstanding orphan).
  const candidates = await prisma.databaseBackup.findMany({
    where: { databaseId, status: 'completed', type: 'scheduled', isPinned: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, size: true, filename: true, lastRotationError: true },
  });

  // Exempt-successful: completed backups that are manual OR pinned. They never
  // get pruned but DO count toward the floor and the size cap total.
  const exempt = await prisma.databaseBackup.findMany({
    where: {
      databaseId,
      status: 'completed',
      OR: [{ type: 'manual' }, { isPinned: true }],
    },
    select: { size: true },
  });
  const exemptSuccessfulCount = exempt.length;
  const exemptSize = exempt.reduce((sum, b) => sum + b.size, BigInt(0));

  // Tier selection -> floor -> size cap.
  let keep = selectKeep(candidates, policy, tz);
  keep = applyFloor(candidates, keep, exemptSuccessfulCount, policy.minFloor);
  const capResult = applySizeCap(
    candidates,
    keep,
    exemptSize,
    exemptSuccessfulCount,
    policy.minFloor,
    policy.maxTotalBytes
  );
  keep = capResult.keep;

  const pruneList = candidates.filter((c) => !keep.has(c.id));
  const keepList = candidates.filter((c) => keep.has(c.id));

  if (dryRun) {
    // Preview: bytesFreed = sum of everything we WOULD prune. A dry run never
    // writes, so we don't clear lastRotationError here.
    const bytesFreed = pruneList.reduce((sum, b) => sum + b.size, BigInt(0));
    return {
      keep: keepList.map((b) => b.id),
      prune: pruneList.map((b) => b.id),
      bytesFreed,
      cappedButUnreachable: capResult.cappedButUnreachable,
    };
  }

  // Clear a stale lastRotationError on any KEPT backup (§ schema: "cleared on
  // success"). A pass that retains the row means there's no outstanding orphan
  // for it, so a previously-recorded prune error is no longer meaningful. One
  // updateMany over just the ids that currently carry an error.
  const keptWithError = keepList.filter((b) => b.lastRotationError != null).map((b) => b.id);
  if (keptWithError.length > 0) {
    await prisma.databaseBackup.updateMany({
      where: { id: { in: keptWithError } },
      data: { lastRotationError: null },
    });
  }

  // Real prune. One backup failing must not abort the whole rotation.
  const errors: { backupId: string; error: string }[] = [];
  const prunedIds: string[] = [];
  const prunedFilenames: string[] = [];
  let bytesFreed = BigInt(0);

  for (const candidate of pruneList) {
    const result = await pruneBackup(candidate.id);
    if (result.ok) {
      prunedIds.push(candidate.id);
      prunedFilenames.push(candidate.filename);
      bytesFreed += candidate.size;
    } else {
      errors.push({ backupId: candidate.id, error: result.error });
    }
  }

  // Audit-log the pass if anything was actually pruned (§6.7).
  if (prunedIds.length > 0) {
    await logAudit({
      action: 'backup.rotate',
      resourceType: 'database',
      resourceId: databaseId,
      details: {
        databaseId,
        policy,
        prunedIds,
        prunedFilenames,
        bytesFreed: Number(bytesFreed), // Number() only here for JSON storage
        trigger,
      },
    });
  }

  // Error / orphan / unreachable-cap notification (§12).
  if (errors.length > 0 || capResult.cappedButUnreachable) {
    const db = await prisma.database.findUnique({
      where: { id: databaseId },
      select: { name: true, environmentId: true },
    });
    if (db) {
      const errorMessage = errors.length > 0
        ? `${errors.length} backup(s) could not be deleted: ${errors.map((e) => e.error).join('; ')}`
        : 'Storage size cap could not be met without removing pinned/manual backups.';
      await sendSystemNotification(
        NOTIFICATION_TYPES.BACKUP_ROTATION_ERROR,
        db.environmentId,
        { databaseName: db.name, error: errorMessage }
      );
    }
  }

  return {
    keep: keepList.map((b) => b.id),
    prune: prunedIds,
    bytesFreed,
    cappedButUnreachable: capResult.cappedButUnreachable,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ===========================================================================
// Failed / stuck backup cleanup (§8) — invoked by the scheduler (Slice C).
// ===========================================================================

/**
 * Mark backups stuck in `in_progress` as failed (§8.1). A backup is "stuck"
 * when its createdAt is older than the database's pg_dump timeout plus a grace
 * margin (falling back to the global pgDumpTimeoutMs when the per-DB value is
 * absent). Returns the number of backups marked failed.
 */
export async function markStuckBackupsFailed(): Promise<number> {
  const now = Date.now();
  const settings = await getSystemSettings();
  const fallbackTimeout = settings.pgDumpTimeoutMs || DEFAULT_PG_DUMP_TIMEOUT_MS;

  const inProgress = await prisma.databaseBackup.findMany({
    where: { status: 'in_progress' },
    select: {
      id: true,
      createdAt: true,
      database: { select: { pgDumpTimeoutMs: true } },
    },
  });

  let marked = 0;
  for (const backup of inProgress) {
    const timeout = backup.database.pgDumpTimeoutMs || fallbackTimeout;
    const stuckAfter = backup.createdAt.getTime() + timeout + STUCK_BACKUP_GRACE_MS;
    if (now <= stuckAfter) continue;

    const backupError: BackupError = {
      message: 'Backup timed out: still in progress past the configured pg_dump timeout. Marked failed by the cleanup sweep.',
      step: 'dump',
    };
    // Conditional update guarded on status='in_progress': if executeBackup
    // legitimately completed (or failed) this row between the findMany above
    // and now, the WHERE matches nothing and we neither clobber it nor count
    // it as marked — avoiding a completed↔failed flap and a false "timed out"
    // notification.
    const { count } = await prisma.databaseBackup.updateMany({
      where: { id: backup.id, status: 'in_progress' },
      data: {
        status: 'failed',
        error: JSON.stringify(backupError),
        completedAt: new Date(),
      },
    });
    if (count > 0) marked++;
  }

  return marked;
}

/**
 * Delete failed backups older than `failedBackupRetentionDays` (§8.2) — the
 * DB row AND any partial artifact, via the same file-first helper used by
 * rotation. Returns the number of rows deleted.
 */
export async function cleanupFailedBackups(): Promise<number> {
  const settings = await getSystemSettings();
  const retentionDays = settings.failedBackupRetentionDays;
  if (retentionDays <= 0) return 0; // 0 = keep forever

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const oldFailed = await prisma.databaseBackup.findMany({
    where: { status: 'failed', createdAt: { lt: cutoff } },
    include: { database: { include: { server: true } } },
  });

  let deleted = 0;
  for (const backup of oldFailed) {
    try {
      const result = await deleteBackupArtifact(backup);
      if (!result.ok) {
        // Keep the row and record the problem; the next sweep retries.
        await prisma.databaseBackup
          .update({ where: { id: backup.id }, data: { lastRotationError: result.error } })
          .catch(() => { /* row may be gone */ });
        console.error(`[Cleanup] Failed to delete artifact for failed backup ${backup.id}: ${result.error}`);
        continue;
      }
      await prisma.databaseBackup.delete({ where: { id: backup.id } });
      deleted++;
    } catch (error) {
      console.error(`[Cleanup] Failed to delete failed backup ${backup.id}:`, getErrorMessage(error));
    }
  }

  return deleted;
}
