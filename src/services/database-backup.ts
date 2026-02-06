import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { SSHClient, LocalClient, isLocalhost, type CommandClient, type LocalExecOptions } from '../lib/ssh.js';
import { getEnvironmentSshKey, getEnvironmentSpacesConfig } from '../routes/environments.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';

// Default pg_dump timeout (5 minutes)
const DEFAULT_PG_DUMP_TIMEOUT_MS = 300000;

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
      databaseType: { select: { id: true, name: true, displayName: true } },
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
      databaseType: { select: { id: true, name: true, displayName: true } },
    },
  });

  return toOutput(db);
}

export async function getDatabase(id: string): Promise<DatabaseOutput | null> {
  const db = await prisma.database.findUnique({
    where: { id },
    include: {
      _count: { select: { backups: true, services: true } },
      databaseType: { select: { id: true, name: true, displayName: true } },
    },
  });

  return db ? toOutput(db) : null;
}

export async function listDatabases(environmentId: string): Promise<DatabaseOutput[]> {
  const dbs = await prisma.database.findMany({
    where: { environmentId },
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { backups: true, services: true } },
      databaseType: { select: { id: true, name: true, displayName: true } },
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
  });

  return dbs.map((db) => {
    const output = toOutput(db);
    output.lastBackup = db.backups[0] || null;
    output.schedule = db.schedule || null;
    return output;
  });
}

export async function deleteDatabase(id: string): Promise<void> {
  await prisma.database.delete({ where: { id } });
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
  serverId: string | null;
  databaseTypeId: string | null;
  databaseType?: { id: string; name: string; displayName: string } | null;
  backupStorageType: string;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  backupFormat: string;
  backupCompression: string;
  backupCompressionLevel: number;
  pgDumpOptions: string | null;
  pgDumpTimeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { backups: number; services: number };
}): DatabaseOutput {
  let parsedPgDumpOptions: PgDumpOptions | null = null;
  if (db.pgDumpOptions) {
    try {
      parsedPgDumpOptions = JSON.parse(db.pgDumpOptions);
    } catch {
      // ignore parse errors
    }
  }
  return {
    id: db.id,
    name: db.name,
    type: db.type,
    host: db.host,
    port: db.port,
    databaseName: db.databaseName,
    hasCredentials: !!db.encryptedCredentials,
    filePath: db.filePath,
    serverId: db.serverId,
    databaseTypeId: db.databaseTypeId,
    databaseType: db.databaseType || null,
    backupStorageType: db.backupStorageType,
    backupLocalPath: db.backupLocalPath,
    backupSpacesBucket: db.backupSpacesBucket,
    backupSpacesPrefix: db.backupSpacesPrefix,
    backupFormat: db.backupFormat,
    backupCompression: db.backupCompression,
    backupCompressionLevel: db.backupCompressionLevel,
    pgDumpOptions: parsedPgDumpOptions,
    pgDumpTimeoutMs: db.pgDumpTimeoutMs,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
    environmentId: db.environmentId,
    _count: db._count,
  };
}

export async function createBackup(
  databaseId: string,
  triggeredById: string,
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
      triggeredById,
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
  let pgOpts: PgDumpOptions = {};
  if (db.pgDumpOptions) {
    try {
      pgOpts = JSON.parse(db.pgDumpOptions);
    } catch {
      // ignore parse errors
    }
  }

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
      await client.exec(`mkdir -p "${targetDir}"`);
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
    const sizeResult = await client.exec(`stat -c %s "${sizeCheckPath}" 2>/dev/null || stat -f %z "${sizeCheckPath}"`);
    const size = parseInt(sizeResult.stdout.trim()) || 0;

    // For SQLite + Spaces, download the dump from server before disconnecting
    if (sqliteServerTempPath && tempPath) {
      // Check if server and local paths are the same (localhost case)
      const isLocalExecution = client instanceof LocalClient;

      if (isLocalExecution && sqliteServerTempPath === tempPath) {
        // Paths are the same on localhost - file is already in place, no need to download
        // Don't delete since we need it for S3 upload
      } else {
        const downloadResult = await client.exec(`cat "${sqliteServerTempPath}" | base64`);
        if (downloadResult.code !== 0) {
          throw new Error(`Failed to download backup from server: ${downloadResult.stderr}`);
        }
        const fileContent = Buffer.from(downloadResult.stdout.trim(), 'base64');
        const { writeFile } = await import('fs/promises');
        await writeFile(tempPath, fileContent);
        // Clean up server temp file (only if different from local temp)
        await client.exec(`rm -f "${sqliteServerTempPath}"`);
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

export async function deleteBackup(id: string): Promise<void> {
  const backup = await prisma.databaseBackup.findUnique({
    where: { id },
    include: { database: { include: { server: true } } },
  });

  if (!backup) throw new Error('Backup not found');

  // Delete file from storage
  if (backup.storageType === 'local' && backup.database.server) {
    let client: CommandClient;
    if (isLocalhost(backup.database.server.hostname)) {
      client = new LocalClient();
    } else {
      const sshCreds = await getEnvironmentSshKey(backup.database.environmentId);
      if (!sshCreds) {
        // Can't delete file without credentials, but still delete DB record
        await prisma.databaseBackup.delete({ where: { id } });
        return;
      }
      client = new SSHClient({
        hostname: backup.database.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });
    }

    try {
      await client.connect();
      await client.exec(`rm -f "${backup.storagePath}"`);
      client.disconnect();
    } catch {
      // Ignore errors when deleting file
    }
  } else if (backup.storageType === 'spaces' && backup.database.backupSpacesBucket) {
    // Delete from Spaces
    try {
      const spacesConfig = await getEnvironmentSpacesConfig(backup.database.environmentId);
      if (spacesConfig) {
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
      }
    } catch {
      // Ignore errors when deleting from Spaces
    }
  }

  await prisma.databaseBackup.delete({ where: { id } });
}

export async function setBackupSchedule(
  databaseId: string,
  cronExpression: string,
  retentionDays: number = 7,
  enabled: boolean = true
) {
  return prisma.backupSchedule.upsert({
    where: { databaseId },
    update: { cronExpression, retentionDays, enabled },
    create: { databaseId, cronExpression, retentionDays, enabled },
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
      database: { include: { server: true, environment: true } },
    },
  });

  if (!backup) throw new Error('Backup not found');
  if (backup.status !== 'completed') throw new Error('Backup is not completed');

  // Check if downloads are allowed
  if (!backup.database.environment.allowBackupDownload) {
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
    const result = await client.exec(`cat "${backup.storagePath}" | base64`);
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

        // Create backup (uses 'scheduler' as the trigger user ID)
        await createBackup(schedule.databaseId, 'scheduler', 'scheduled');

        // Clean up old backups based on retention policy
        await enforceRetention(schedule.databaseId, schedule.retentionDays);
      }
    } catch (error) {
      console.error(`[Scheduler] Failed to run backup for database ${schedule.database.name}:`, error);
    }
  }
}

/**
 * Check if a cron schedule is due to run.
 * Simplified implementation - checks common patterns.
 */
function isScheduleDue(cronExpression: string, lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true; // Never run before

  const msSinceLastRun = now.getTime() - lastRunAt.getTime();
  const hoursSinceLastRun = msSinceLastRun / (1000 * 60 * 60);

  // Parse common cron patterns
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) return false;

  // Daily at specific hour (e.g., "0 2 * * *" = daily at 2am)
  if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return hoursSinceLastRun >= 24;
  }

  // Hourly (e.g., "0 * * * *")
  if (parts[1] === '*') {
    return hoursSinceLastRun >= 1;
  }

  // Weekly (e.g., "0 2 * * 0")
  if (parts[4] !== '*') {
    return hoursSinceLastRun >= 24 * 7;
  }

  // Default: daily
  return hoursSinceLastRun >= 24;
}

/**
 * Calculate next run time for a cron expression.
 */
function getNextRunTime(cronExpression: string, from: Date): Date {
  const parts = cronExpression.trim().split(/\s+/);
  const next = new Date(from);

  // Simple calculation - add appropriate interval
  if (parts[1] === '*') {
    next.setHours(next.getHours() + 1);
  } else if (parts[4] !== '*') {
    next.setDate(next.getDate() + 7);
  } else {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

/**
 * Delete old backups based on retention policy.
 */
async function enforceRetention(databaseId: string, retentionDays: number): Promise<void> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const oldBackups = await prisma.databaseBackup.findMany({
    where: {
      databaseId,
      createdAt: { lt: cutoffDate },
      type: 'scheduled', // Only auto-delete scheduled backups, not manual ones
    },
  });

  for (const backup of oldBackups) {
    try {
      await deleteBackup(backup.id);
      console.log(`[Scheduler] Deleted old backup ${backup.filename} (retention policy)`);
    } catch (error) {
      console.error(`[Scheduler] Failed to delete old backup ${backup.id}:`, error);
    }
  }
}
