import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';

// JSON Schema validation types
interface ServiceTypeJson {
  name: string;
  displayName: string;
  commands: Array<{
    name: string;
    displayName: string;
    command: string;
    description?: string;
    sortOrder?: number;
  }>;
}

interface MonitoringQueryJson {
  name: string;
  displayName: string;
  query: string;
  resultType: 'scalar' | 'row' | 'rows';
  unit?: string;
  chartGroup?: string;
  resultMapping?: Record<string, string>;
}

interface MonitoringConfigJson {
  connectionMode: 'sql' | 'ssh' | 'redis';
  driver?: 'pg' | 'mysql2';
  queries: MonitoringQueryJson[];
}

interface DatabaseTypeJson {
  name: string;
  displayName: string;
  defaultPort?: number;
  connectionFields: Array<{
    name: string;
    label: string;
    type: 'text' | 'number' | 'password';
    required?: boolean;
    default?: unknown;
  }>;
  backupCommand?: string;
  restoreCommand?: string;
  commands?: Array<{
    name: string;
    displayName: string;
    command: string;
    description?: string;
    sortOrder?: number;
  }>;
  monitoring?: MonitoringConfigJson;
}

export interface PluginSyncResult {
  serviceTypes: {
    created: string[];
    updated: string[];
    skippedCustomized: string[];
    errors: Array<{ file: string; error: string }>;
  };
  databaseTypes: {
    created: string[];
    updated: string[];
    skippedCustomized: string[];
    errors: Array<{ file: string; error: string }>;
  };
  timestamp: string;
}

// In-memory store for last sync result
let lastSyncResult: PluginSyncResult | null = null;

export function getLastSyncResult(): PluginSyncResult | null {
  return lastSyncResult;
}

function validateServiceTypeJson(data: unknown, file: string): ServiceTypeJson | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !/^[a-z0-9-]+$/.test(obj.name)) {
    console.error(`[Plugins] Invalid name in ${file}`);
    return null;
  }
  if (typeof obj.displayName !== 'string' || !obj.displayName) {
    console.error(`[Plugins] Missing displayName in ${file}`);
    return null;
  }
  if (!Array.isArray(obj.commands)) {
    console.error(`[Plugins] Missing commands array in ${file}`);
    return null;
  }
  for (const cmd of obj.commands) {
    if (!cmd || typeof cmd !== 'object') return null;
    if (typeof cmd.name !== 'string' || typeof cmd.displayName !== 'string' || typeof cmd.command !== 'string') {
      console.error(`[Plugins] Invalid command in ${file}`);
      return null;
    }
  }
  return data as ServiceTypeJson;
}

function validateDatabaseTypeJson(data: unknown, file: string): DatabaseTypeJson | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !/^[a-z0-9-]+$/.test(obj.name)) {
    console.error(`[Plugins] Invalid name in ${file}`);
    return null;
  }
  if (typeof obj.displayName !== 'string' || !obj.displayName) {
    console.error(`[Plugins] Missing displayName in ${file}`);
    return null;
  }
  if (!Array.isArray(obj.connectionFields)) {
    console.error(`[Plugins] Missing connectionFields array in ${file}`);
    return null;
  }
  return data as DatabaseTypeJson;
}

async function loadJsonFiles<T>(
  dir: string,
  validate: (data: unknown, file: string) => T | null
): Promise<Array<{ data: T; file: string }>> {
  const results: Array<{ data: T; file: string }> = [];
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        const parsed = JSON.parse(content);
        const validated = validate(parsed, file);
        if (validated) {
          results.push({ data: validated, file });
        }
      } catch (err) {
        console.error(`[Plugins] Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch {
    // Directory doesn't exist - that's ok
  }
  return results;
}

async function syncServiceTypes(result: PluginSyncResult): Promise<void> {
  const dir = join(config.PLUGINS_DIR, 'service-types');
  const files = await loadJsonFiles(dir, validateServiceTypeJson);

  for (const { data, file } of files) {
    try {
      const existing = await prisma.serviceType.findUnique({
        where: { name: data.name },
        include: { commands: true },
      });

      if (!existing) {
        // Create new
        await prisma.serviceType.create({
          data: {
            name: data.name,
            displayName: data.displayName,
            source: 'plugin',
            isCustomized: false,
            commands: {
              create: data.commands.map((cmd, i) => ({
                name: cmd.name,
                displayName: cmd.displayName,
                command: cmd.command,
                description: cmd.description || null,
                sortOrder: cmd.sortOrder ?? i,
              })),
            },
          },
        });
        result.serviceTypes.created.push(data.name);
      } else if (!existing.isCustomized) {
        // Update non-customized: replace all commands
        await prisma.$transaction([
          prisma.serviceTypeCommand.deleteMany({ where: { serviceTypeId: existing.id } }),
          prisma.serviceType.update({
            where: { id: existing.id },
            data: {
              displayName: data.displayName,
              source: 'plugin',
              commands: {
                create: data.commands.map((cmd, i) => ({
                  name: cmd.name,
                  displayName: cmd.displayName,
                  command: cmd.command,
                  description: cmd.description || null,
                  sortOrder: cmd.sortOrder ?? i,
                })),
              },
            },
          }),
        ]);
        result.serviceTypes.updated.push(data.name);
      } else {
        // Customized: only add new commands that don't exist
        const existingNames = new Set(existing.commands.map(c => c.name));
        const newCommands = data.commands.filter(c => !existingNames.has(c.name));

        if (newCommands.length > 0) {
          await prisma.serviceTypeCommand.createMany({
            data: newCommands.map((cmd, i) => ({
              name: cmd.name,
              displayName: cmd.displayName,
              command: cmd.command,
              description: cmd.description || null,
              sortOrder: (existing.commands.length + i) * 10,
              serviceTypeId: existing.id,
            })),
          });
          console.log(`[Plugins] Added ${newCommands.length} new commands to customized service type "${data.name}"`);
        }
        result.serviceTypes.skippedCustomized.push(data.name);
      }
    } catch (err) {
      result.serviceTypes.errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function syncDatabaseTypes(result: PluginSyncResult): Promise<void> {
  const dir = join(config.PLUGINS_DIR, 'database-types');
  const files = await loadJsonFiles(dir, validateDatabaseTypeJson);

  for (const { data, file } of files) {
    try {
      const existing = await prisma.databaseType.findUnique({
        where: { name: data.name },
        include: { commands: true },
      });

      if (!existing) {
        // Create new
        const dbType = await prisma.databaseType.create({
          data: {
            name: data.name,
            displayName: data.displayName,
            source: 'plugin',
            isCustomized: false,
            connectionFields: JSON.stringify(data.connectionFields),
            backupCommand: data.backupCommand || null,
            restoreCommand: data.restoreCommand || null,
            defaultPort: data.defaultPort || null,
            monitoringConfig: data.monitoring ? JSON.stringify(data.monitoring) : null,
            commands: {
              create: (data.commands || []).map((cmd, i) => ({
                name: cmd.name,
                displayName: cmd.displayName,
                command: cmd.command,
                description: cmd.description || null,
                sortOrder: cmd.sortOrder ?? i,
              })),
            },
          },
        });

        // Auto-link existing databases by type name
        await prisma.database.updateMany({
          where: { type: data.name, databaseTypeId: null },
          data: { databaseTypeId: dbType.id },
        });

        result.databaseTypes.created.push(data.name);
      } else if (!existing.isCustomized) {
        // Update non-customized: replace everything
        await prisma.$transaction([
          prisma.databaseTypeCommand.deleteMany({ where: { databaseTypeId: existing.id } }),
          prisma.databaseType.update({
            where: { id: existing.id },
            data: {
              displayName: data.displayName,
              source: 'plugin',
              connectionFields: JSON.stringify(data.connectionFields),
              backupCommand: data.backupCommand || null,
              restoreCommand: data.restoreCommand || null,
              defaultPort: data.defaultPort || null,
              monitoringConfig: data.monitoring ? JSON.stringify(data.monitoring) : null,
              commands: {
                create: (data.commands || []).map((cmd, i) => ({
                  name: cmd.name,
                  displayName: cmd.displayName,
                  command: cmd.command,
                  description: cmd.description || null,
                  sortOrder: cmd.sortOrder ?? i,
                })),
              },
            },
          }),
        ]);

        // Auto-link any unlinked databases
        await prisma.database.updateMany({
          where: { type: data.name, databaseTypeId: null },
          data: { databaseTypeId: existing.id },
        });

        result.databaseTypes.updated.push(data.name);
      } else {
        // Customized: only add new commands
        const existingNames = new Set(existing.commands.map(c => c.name));
        const newCommands = (data.commands || []).filter(c => !existingNames.has(c.name));

        if (newCommands.length > 0) {
          await prisma.databaseTypeCommand.createMany({
            data: newCommands.map((cmd, i) => ({
              name: cmd.name,
              displayName: cmd.displayName,
              command: cmd.command,
              description: cmd.description || null,
              sortOrder: (existing.commands.length + i) * 10,
              databaseTypeId: existing.id,
            })),
          });
          console.log(`[Plugins] Added ${newCommands.length} new commands to customized database type "${data.name}"`);
        }
        result.databaseTypes.skippedCustomized.push(data.name);
      }
    } catch (err) {
      result.databaseTypes.errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Sync plugins from JSON files to database.
 * Called on server startup, replaces initializeServiceTypes().
 */
export async function syncPlugins(): Promise<PluginSyncResult> {
  console.log('[Plugins] Syncing plugins from', config.PLUGINS_DIR);

  const result: PluginSyncResult = {
    serviceTypes: { created: [], updated: [], skippedCustomized: [], errors: [] },
    databaseTypes: { created: [], updated: [], skippedCustomized: [], errors: [] },
    timestamp: new Date().toISOString(),
  };

  await syncServiceTypes(result);
  await syncDatabaseTypes(result);

  const totalCreated = result.serviceTypes.created.length + result.databaseTypes.created.length;
  const totalUpdated = result.serviceTypes.updated.length + result.databaseTypes.updated.length;
  const totalErrors = result.serviceTypes.errors.length + result.databaseTypes.errors.length;

  console.log(
    `[Plugins] Sync complete: ${totalCreated} created, ${totalUpdated} updated, ${totalErrors} errors`
  );

  lastSyncResult = result;
  return result;
}

/**
 * Reset a service type or database type to its JSON defaults.
 */
export async function resetTypeToDefaults(
  kind: 'service-type' | 'database-type',
  id: string
): Promise<boolean> {
  if (kind === 'service-type') {
    const type = await prisma.serviceType.findUnique({ where: { id } });
    if (!type) return false;

    const dir = join(config.PLUGINS_DIR, 'service-types');
    const filePath = join(dir, `${type.name}.json`);

    try {
      const content = await readFile(filePath, 'utf-8');
      const data = validateServiceTypeJson(JSON.parse(content), `${type.name}.json`);
      if (!data) return false;

      await prisma.$transaction([
        prisma.serviceTypeCommand.deleteMany({ where: { serviceTypeId: id } }),
        prisma.serviceType.update({
          where: { id },
          data: {
            displayName: data.displayName,
            isCustomized: false,
            commands: {
              create: data.commands.map((cmd, i) => ({
                name: cmd.name,
                displayName: cmd.displayName,
                command: cmd.command,
                description: cmd.description || null,
                sortOrder: cmd.sortOrder ?? i,
              })),
            },
          },
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  } else {
    const type = await prisma.databaseType.findUnique({ where: { id } });
    if (!type) return false;

    const dir = join(config.PLUGINS_DIR, 'database-types');
    const filePath = join(dir, `${type.name}.json`);

    try {
      const content = await readFile(filePath, 'utf-8');
      const data = validateDatabaseTypeJson(JSON.parse(content), `${type.name}.json`);
      if (!data) return false;

      await prisma.$transaction([
        prisma.databaseTypeCommand.deleteMany({ where: { databaseTypeId: id } }),
        prisma.databaseType.update({
          where: { id },
          data: {
            displayName: data.displayName,
            isCustomized: false,
            connectionFields: JSON.stringify(data.connectionFields),
            backupCommand: data.backupCommand || null,
            restoreCommand: data.restoreCommand || null,
            defaultPort: data.defaultPort || null,
            monitoringConfig: data.monitoring ? JSON.stringify(data.monitoring) : null,
            commands: {
              create: (data.commands || []).map((cmd, i) => ({
                name: cmd.name,
                displayName: cmd.displayName,
                command: cmd.command,
                description: cmd.description || null,
                sortOrder: cmd.sortOrder ?? i,
              })),
            },
          },
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Export a type as a JSON file to the plugins directory.
 */
export async function exportTypeAsJson(
  kind: 'service-type' | 'database-type',
  id: string
): Promise<{ written: boolean; error?: string }> {
  try {
    if (kind === 'service-type') {
      const type = await prisma.serviceType.findUnique({
        where: { id },
        include: { commands: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!type) return { written: false, error: 'Service type not found' };

      const json: ServiceTypeJson = {
        name: type.name,
        displayName: type.displayName,
        commands: type.commands.map(cmd => ({
          name: cmd.name,
          displayName: cmd.displayName,
          command: cmd.command,
          ...(cmd.description ? { description: cmd.description } : {}),
          sortOrder: cmd.sortOrder,
        })),
      };

      const dir = join(config.PLUGINS_DIR, 'service-types');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${type.name}.json`), JSON.stringify(json, null, 2) + '\n');
      return { written: true };
    } else {
      const type = await prisma.databaseType.findUnique({
        where: { id },
        include: { commands: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!type) return { written: false, error: 'Database type not found' };

      const json: Record<string, unknown> = {
        name: type.name,
        displayName: type.displayName,
      };
      if (type.defaultPort) json.defaultPort = type.defaultPort;
      json.connectionFields = JSON.parse(type.connectionFields);
      if (type.backupCommand) json.backupCommand = type.backupCommand;
      if (type.restoreCommand) json.restoreCommand = type.restoreCommand;
      if (type.commands.length > 0) {
        json.commands = type.commands.map(cmd => ({
          name: cmd.name,
          displayName: cmd.displayName,
          command: cmd.command,
          ...(cmd.description ? { description: cmd.description } : {}),
          sortOrder: cmd.sortOrder,
        }));
      }
      if (type.monitoringConfig) {
        json.monitoring = JSON.parse(type.monitoringConfig);
      }

      const dir = join(config.PLUGINS_DIR, 'database-types');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${type.name}.json`), JSON.stringify(json, null, 2) + '\n');
      return { written: true };
    }
  } catch (err) {
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  }
}
