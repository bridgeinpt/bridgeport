import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { SSHClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import crypto from 'crypto';

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
    include: { _count: { select: { backups: true, services: true } } },
  });

  return dbs.map(toOutput);
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

  try {
    let dumpCommand = '';
    let targetPath = backup.storagePath;

    // Get SSH credentials if we have a server
    const sshCreds = db.server
      ? await getEnvironmentSshKey(db.environmentId)
      : null;

    if (db.type === 'postgres' && db.host) {
      // Get credentials
      let username = '';
      let password = '';
      if (db.encryptedCredentials && db.credentialsNonce) {
        const creds = decrypt(db.encryptedCredentials, db.credentialsNonce);
        [username, password] = creds.split(':');
      }

      dumpCommand = `PGPASSWORD='${password}' pg_dump -h ${db.host} -p ${db.port || 5432} -U ${username} -d ${db.databaseName} > ${targetPath}`;
    } else if (db.type === 'sqlite' && db.filePath) {
      dumpCommand = `sqlite3 ${db.filePath} .dump > ${targetPath}`;
    } else {
      throw new Error(`Unsupported database type or missing configuration: ${db.type}`);
    }

    // Execute backup via SSH if we have a server
    if (sshCreds && db.server) {
      const ssh = new SSHClient({
        hostname: db.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });

      await ssh.connect();

      // Ensure backup directory exists
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      await ssh.exec(`mkdir -p "${targetDir}"`);

      const result = await ssh.exec(dumpCommand);
      if (result.code !== 0) {
        throw new Error(result.stderr || 'Backup command failed');
      }

      // Get file size
      const sizeResult = await ssh.exec(`stat -c %s "${targetPath}" 2>/dev/null || stat -f %z "${targetPath}"`);
      const size = parseInt(sizeResult.stdout.trim()) || 0;

      ssh.disconnect();

      await prisma.databaseBackup.update({
        where: { id: backupId },
        data: {
          status: 'completed',
          size: BigInt(size),
          completedAt: new Date(),
        },
      });
    } else {
      throw new Error('No server configured for this database');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await prisma.databaseBackup.update({
      where: { id: backupId },
      data: {
        status: 'failed',
        error: message,
        completedAt: new Date(),
      },
    });
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
    const sshCreds = await getEnvironmentSshKey(backup.database.environmentId);
    if (sshCreds) {
      const ssh = new SSHClient({
        hostname: backup.database.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });

      try {
        await ssh.connect();
        await ssh.exec(`rm -f "${backup.storagePath}"`);
        ssh.disconnect();
      } catch {
        // Ignore errors when deleting file
      }
    }
  }
  // TODO: Handle Spaces deletion

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
