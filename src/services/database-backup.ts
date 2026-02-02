import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { SSHClient, LocalClient, isLocalhost, type CommandClient, type LocalExecOptions } from '../lib/ssh.js';
import { getEnvironmentSshKey, getEnvironmentSpacesConfig } from '../routes/environments.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';

export type BackupStep = 'connect' | 'dump' | 'upload';

export interface BackupError {
  message: string;
  step: BackupStep;
  stderr?: string;
  exitCode?: number;
}

export interface DatabaseInput {
  name: string;
  type: 'postgres' | 'mysql' | 'sqlite';
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
  backupStorageType: string;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { backups: number; services: number };
  lastBackup?: LastBackupInfo | null;
  schedule?: ScheduleInfo | null;
}

export async function createDatabase(
  environmentId: string,
  input: DatabaseInput
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
    backupStorageType: string;
    backupLocalPath?: string;
    backupSpacesBucket?: string;
    backupSpacesPrefix?: string;
    environmentId: string;
  } = {
    name: input.name,
    type: input.type,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    filePath: input.filePath,
    serverId: input.serverId,
    backupStorageType: input.backupStorageType || 'local',
    backupLocalPath: input.backupLocalPath,
    backupSpacesBucket: input.backupSpacesBucket,
    backupSpacesPrefix: input.backupSpacesPrefix,
    environmentId,
  };

  if (input.username && input.password) {
    const credentials = `${input.username}:${input.password}`;
    const { ciphertext, nonce } = encrypt(credentials);
    data.encryptedCredentials = ciphertext;
    data.credentialsNonce = nonce;
  }

  const db = await prisma.database.create({
    data,
    include: { _count: { select: { backups: true, services: true } } },
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
    include: { _count: { select: { backups: true, services: true } } },
  });

  return toOutput(db);
}

export async function getDatabase(id: string): Promise<DatabaseOutput | null> {
  const db = await prisma.database.findUnique({
    where: { id },
    include: { _count: { select: { backups: true, services: true } } },
  });

  return db ? toOutput(db) : null;
}

export async function listDatabases(environmentId: string): Promise<DatabaseOutput[]> {
  const dbs = await prisma.database.findMany({
    where: { environmentId },
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { backups: true, services: true } },
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
  backupStorageType: string;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  createdAt: Date;
  updatedAt: Date;
  environmentId: string;
  _count?: { backups: number; services: number };
}): DatabaseOutput {
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
    backupStorageType: db.backupStorageType,
    backupLocalPath: db.backupLocalPath,
    backupSpacesBucket: db.backupSpacesBucket,
    backupSpacesPrefix: db.backupSpacesPrefix,
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
  const filename = `${db.name}-${timestamp}.sql`;

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
    },
  });

  // Execute backup in background (simplified - in production would use a job queue)
  executeBackup(backup.id).catch((err) => {
    console.error(`Backup ${backup.id} failed:`, err);
  });

  return { backupId: backup.id };
}

async function executeBackup(backupId: string): Promise<void> {
  const backup = await prisma.databaseBackup.update({
    where: { id: backupId },
    data: { status: 'in_progress' },
    include: {
      database: {
        include: { environment: true, server: true },
      },
    },
  });

  const db = backup.database;
  const useSpaces = db.backupStorageType === 'spaces';

  // For Spaces, dump to temp file first; for local, dump to final path
  const tempPath = useSpaces ? join(tmpdir(), `backup-${backupId}.sql`) : null;
  const targetPath = tempPath || backup.storagePath;

  let currentStep: BackupStep = 'connect';

  try {
    let dumpCommand = '';
    let client: CommandClient;
    let password = '';
    let execOptions: LocalExecOptions | undefined;

    if (db.type === 'postgres' && db.host) {
      // Postgres: run pg_dump locally (connects remotely to database)
      client = new LocalClient();

      let username = '';
      if (db.encryptedCredentials && db.credentialsNonce) {
        const creds = decrypt(db.encryptedCredentials, db.credentialsNonce);
        [username, password] = creds.split(':');
      }

      // Pass password and SSL mode via environment variables for security (not visible in ps)
      // DigitalOcean and most managed databases require SSL
      dumpCommand = `pg_dump --no-password -h ${db.host} -p ${db.port || 5432} -U ${username} -d ${db.databaseName} > "${targetPath}"`;
      execOptions = { env: { PGPASSWORD: password, PGSSLMODE: 'require' } };
    } else if (db.type === 'sqlite' && db.filePath) {
      if (!db.server) {
        throw new Error('SQLite databases require a server to be configured');
      }

      // For SQLite with Spaces, we need to dump on the server then transfer
      // For simplicity, SQLite + Spaces is not supported yet (would need SFTP download)
      if (useSpaces) {
        throw new Error('SQLite backups to Spaces are not yet supported. Use local storage or switch to Postgres.');
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

      dumpCommand = `sqlite3 "${db.filePath}" ".dump" > "${targetPath}"`;
    } else {
      throw new Error(`Unsupported database type or missing configuration: ${db.type}`);
    }

    await client.connect();
    currentStep = 'dump';

    // Ensure backup directory exists (for local storage)
    if (!useSpaces) {
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      await client.exec(`mkdir -p "${targetDir}"`);
    }

    const result = await client.exec(dumpCommand, execOptions);
    if (result.code !== 0) {
      const error: BackupError = {
        message: result.stderr || 'Backup command failed',
        step: 'dump',
        stderr: result.stderr,
        exitCode: result.code,
      };
      throw error;
    }

    // Get file size
    const sizeResult = await client.exec(`stat -c %s "${targetPath}" 2>/dev/null || stat -f %z "${targetPath}"`);
    const size = parseInt(sizeResult.stdout.trim()) || 0;

    client.disconnect();

    // Upload to Spaces if configured
    if (useSpaces && tempPath) {
      currentStep = 'upload';
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

      await s3Client.send(new PutObjectCommand({
        Bucket: db.backupSpacesBucket,
        Key: spacesKey,
        Body: fileContent,
        ContentType: 'application/sql',
      }));

      // Clean up temp file
      await unlink(tempPath).catch(() => {});
    }

    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: {
        status: 'completed',
        size: BigInt(size),
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

    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: {
        status: 'failed',
        error: JSON.stringify(backupError),
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

export async function listBackups(databaseId: string) {
  return prisma.databaseBackup.findMany({
    where: { databaseId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      triggeredBy: { select: { id: true, email: true, name: true } },
    },
  });
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
