import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { validateBody, getErrorMessage } from '../lib/helpers.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { extractKeyValues, substituteFullValue } from '../lib/config-scan-parsing.js';
import { syncUsageForConfigFile } from '../lib/key-usage-extraction.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const applySchema = z
  .object({
    kind: z.enum(['hardcoded_value', 'missing_reference']),
    value: z.string().min(1),
    key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase with underscores'),
    type: z.enum(['secret', 'var']),
    fileIds: z.array(z.string()),
    existingSecretId: z.string().nullable(),
  })
  .refine((d) => d.kind === 'missing_reference' || d.fileIds.length > 0, {
    message: 'fileIds must contain at least one file when extracting a hardcoded value',
    path: ['fileIds'],
  })
  .refine((d) => d.kind === 'hardcoded_value' || (d.fileIds.length === 0 && d.existingSecretId === null), {
    message: 'missing_reference applies create a new secret/var only — no files or existing match',
    path: ['kind'],
  });

// Preview uses the same schema as apply
const previewSchema = applySchema;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shannon entropy of a string (bits per character). */
function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Keywords that indicate a value is secret-like. */
const SECRET_KEYWORDS = [
  'password', 'passwd', 'secret', 'key', 'token',
  'api', 'auth', 'credential', 'cert', 'private',
];

/** Classify a key name as "secret" or "var". */
function classifyType(keyName: string): 'secret' | 'var' {
  const lower = keyName.toLowerCase();
  return SECRET_KEYWORDS.some((kw) => lower.includes(kw)) ? 'secret' : 'var';
}

/** Normalize a key name to UPPER_SNAKE_CASE. */
function toUpperSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase -> camel_Case
    .replace(/[^A-Za-z0-9]/g, '_')        // non-alphanumeric -> _
    .replace(/_+/g, '_')                   // collapse multiple _
    .replace(/^_|_$/g, '')                 // trim leading/trailing _
    .toUpperCase();
}

/** Regex to extract ${KEY} references — supports ${KEY} and ${KEY:-default}. */
const REFERENCE_REGEX = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g;

/**
 * Compute per-line diff hunks. Substitution preserves line structure
 * (value is replaced with ${KEY} within a line), so a positional pass is sufficient.
 */
function computeHunks(
  before: string,
  after: string
): Array<{ lineNumber: number; before: string; after: string }> {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const hunks: Array<{ lineNumber: number; before: string; after: string }> = [];
  const len = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < len; i++) {
    const b = beforeLines[i] ?? '';
    const a = afterLines[i] ?? '';
    if (b !== a) {
      hunks.push({ lineNumber: i + 1, before: b, after: a });
    }
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AffectedFile {
  id: string;
  name: string;
  occurrences: number;
}

interface Suggestion {
  /** 'hardcoded_value' = literal in files to extract; 'missing_reference' = ${KEY} used but undefined */
  kind: 'hardcoded_value' | 'missing_reference';
  value: string;
  proposedKey: string;
  proposedType: 'secret' | 'var';
  occurrenceCount: number;
  affectedFiles: AffectedFile[];
  existingSecretId: string | null;
  existingSecretKey: string | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function configScanRoutes(fastify: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/environments/:envId/config-scan
  // Scan config files for values that should be secrets/vars
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/environments/:envId/config-scan',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      // Load scan settings
      const configSettings = await prisma.configurationSettings.findUnique({
        where: { environmentId: envId },
      });
      const minLength = (configSettings as Record<string, unknown>)?.scanMinLength as number ?? 6;
      const entropyThresholdScaled = (configSettings as Record<string, unknown>)?.scanEntropyThreshold as number ?? 25;
      const entropyThreshold = entropyThresholdScaled / 10; // Stored as ×10 integer

      // Count binary files for stats
      const [configFiles, binaryCount] = await Promise.all([
        prisma.configFile.findMany({
          where: { environmentId: envId, isBinary: false },
          select: { id: true, name: true, content: true },
        }),
        prisma.configFile.count({
          where: { environmentId: envId, isBinary: true },
        }),
      ]);

      // Load existing secrets (decrypted) and vars
      const [existingSecrets, existingVars] = await Promise.all([
        prisma.secret.findMany({
          where: { environmentId: envId },
          select: { id: true, key: true, encryptedValue: true, nonce: true },
        }),
        prisma.var.findMany({
          where: { environmentId: envId },
          select: { id: true, key: true, value: true },
        }),
      ]);

      // Decrypt secrets for comparison
      const decryptedSecrets: Array<{ id: string; key: string; value: string }> = [];
      for (const secret of existingSecrets) {
        try {
          const value = decrypt(secret.encryptedValue, secret.nonce);
          decryptedSecrets.push({ id: secret.id, key: secret.key, value });
        } catch {
          // Skip secrets that fail to decrypt
        }
      }

      // Combine secrets + vars into a single lookup
      const existingValues = new Map<string, { id: string; key: string; type: 'secret' | 'var' }>();
      for (const s of decryptedSecrets) {
        existingValues.set(s.value, { id: s.id, key: s.key, type: 'secret' });
      }
      for (const v of existingVars) {
        existingValues.set(v.value, { id: v.id, key: v.key, type: 'var' });
      }

      // Track values across files with per-file occurrence counts
      const valueMap = new Map<string, {
        files: Map<string, { name: string; count: number }>; // fileId -> { name, count }
        keys: string[];
      }>();

      for (const file of configFiles) {
        const pairs = extractKeyValues(file.content);
        for (const { key, value } of pairs) {
          if (value.length < minLength) continue;
          // Skip values that look like variable references
          if (value.startsWith('${') || value.startsWith('$') || value.startsWith('{{')) continue;

          let entry = valueMap.get(value);
          if (!entry) {
            entry = { files: new Map(), keys: [] };
            valueMap.set(value, entry);
          }
          const fileEntry = entry.files.get(file.id);
          if (fileEntry) {
            fileEntry.count++;
          } else {
            entry.files.set(file.id, { name: file.name, count: 1 });
          }
          entry.keys.push(key);
        }
      }

      // Build suggestions
      const suggestions: Suggestion[] = [];

      for (const [value, entry] of valueMap) {
        const entropy = shannonEntropy(value);
        if (entropy <= entropyThreshold) continue;

        const affectedFiles: AffectedFile[] = Array.from(entry.files.entries()).map(
          ([id, { name, count }]) => ({ id, name, occurrences: count })
        );
        const isPlaintextLeak = existingValues.has(value);

        // Detection signals: same value in 2+ files, or plaintext leak of an
        // existing secret/var. Cross-key (same value under different keys) is
        // intentionally NOT a signal — coincidental matches (e.g. three CADDY_*
        // backends all pointing at the same host:port) are different settings,
        // not a shared variable, and merging them produces noisy/recursive
        // suggestions like `CADDY_OS_CONSOLE_BACKEND=${CADDY_OS_CONSOLE_BACKEND}`.
        const crossFile = affectedFiles.length >= 2;
        if (!crossFile && !isPlaintextLeak) continue;

        // Pick the best key name: most common, tie-break longest
        const keyFreq = new Map<string, number>();
        for (const k of entry.keys) keyFreq.set(k, (keyFreq.get(k) || 0) + 1);
        const sortedKeys = [...keyFreq.entries()].sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1]; // higher count first
          return b[0].length - a[0].length;       // longer key first
        });
        const bestKey = sortedKeys[0][0];
        const proposedKey = toUpperSnakeCase(bestKey);
        const proposedType = classifyType(proposedKey);

        // Check if value already exists as a secret/var
        const existing = existingValues.get(value);
        const occurrenceCount = entry.keys.length;

        suggestions.push({
          kind: 'hardcoded_value',
          value,
          proposedKey: existing ? existing.key : proposedKey,
          proposedType: existing ? existing.type : proposedType,
          occurrenceCount,
          affectedFiles,
          existingSecretId: existing ? existing.id : null,
          existingSecretKey: existing ? existing.key : null,
        });
      }

      const existingKeys = new Set<string>([
        ...decryptedSecrets.map((s) => s.key),
        ...existingVars.map((v) => v.key),
      ]);
      const referenceMap = new Map<string, Map<string, { name: string; count: number }>>();

      for (const file of configFiles) {
        for (const match of file.content.matchAll(REFERENCE_REGEX)) {
          const refKey = match[1];
          if (existingKeys.has(refKey)) continue;

          let fileMap = referenceMap.get(refKey);
          if (!fileMap) {
            fileMap = new Map();
            referenceMap.set(refKey, fileMap);
          }
          const entry = fileMap.get(file.id);
          if (entry) {
            entry.count++;
          } else {
            fileMap.set(file.id, { name: file.name, count: 1 });
          }
        }
      }

      for (const [refKey, fileMap] of referenceMap) {
        const refAffectedFiles: AffectedFile[] = Array.from(fileMap.entries()).map(
          ([id, { name, count }]) => ({ id, name, occurrences: count })
        );
        const refOccurrenceCount = refAffectedFiles.reduce((sum, f) => sum + f.occurrences, 0);

        suggestions.push({
          kind: 'missing_reference',
          value: '',
          proposedKey: refKey,
          proposedType: classifyType(refKey),
          occurrenceCount: refOccurrenceCount,
          affectedFiles: refAffectedFiles,
          existingSecretId: null,
          existingSecretKey: null,
        });
      }

      // Sort: missing references first (more actionable), then by occurrence, secret-type tie-break
      suggestions.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'missing_reference' ? -1 : 1;
        if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
        if (a.proposedType !== b.proposedType) return a.proposedType === 'secret' ? -1 : 1;
        return 0;
      });

      return {
        suggestions,
        scannedFileCount: configFiles.length,
        skippedBinaryCount: binaryCount,
      };
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/environments/:envId/config-scan/preview
  // Preview diffs for a proposed substitution
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/environments/:envId/config-scan/preview',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(previewSchema, request, reply);
      if (!body) return;

      const { value, key, fileIds } = body;

      // Load requested files
      const configFiles = await prisma.configFile.findMany({
        where: {
          id: { in: fileIds },
          environmentId: envId,
          isBinary: false,
        },
        select: { id: true, name: true, content: true },
      });

      const placeholder = '${' + key + '}';
      const diffs: Array<{
        fileId: string;
        fileName: string;
        replacements: number;
        hunks: Array<{ lineNumber: number; before: string; after: string }>;
      }> = [];

      for (const file of configFiles) {
        const before = file.content;
        const { newContent: after, replacements } = substituteFullValue(before, value, placeholder);

        diffs.push({
          fileId: file.id,
          fileName: file.name,
          replacements,
          hunks: replacements === 0 ? [] : computeHunks(before, after),
        });
      }

      return { diffs };
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/environments/:envId/config-scan/apply
  // Create secret/var and substitute value in files
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/environments/:envId/config-scan/apply',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(applySchema, request, reply);
      if (!body) return;

      const { value, key, type, fileIds, existingSecretId } = body;
      const actor = actorFrom(request);
      const editedById = userIdForFk(request.authUser!);
      const placeholder = '${' + key + '}';

      // Step 1: Create secret/var if needed
      let secretOrVarId = existingSecretId;

      if (!existingSecretId) {
        try {
          if (type === 'secret') {
            const { ciphertext, nonce } = encrypt(value);
            const secret = await prisma.secret.create({
              data: {
                key,
                encryptedValue: ciphertext,
                nonce,
                environmentId: envId,
              },
            });
            secretOrVarId = secret.id;

            await logAudit({
              action: 'create',
              resourceType: 'secret',
              resourceId: secret.id,
              resourceName: key,
              details: { source: 'config_scan' },
              ...actor,
              environmentId: envId,
            });
          } else {
            const envVar = await prisma.var.create({
              data: {
                key,
                value,
                environmentId: envId,
              },
            });
            secretOrVarId = envVar.id;

            await logAudit({
              action: 'create',
              resourceType: 'var',
              resourceId: envVar.id,
              resourceName: key,
              details: { source: 'config_scan' },
              ...actor,
              environmentId: envId,
            });
          }
        } catch (error) {
          return reply.code(409).send({
            error: getErrorMessage(error, `Failed to create ${type}`),
          });
        }
      }

      // Step 2: Substitute value in each file
      const configFiles = await prisma.configFile.findMany({
        where: {
          id: { in: fileIds },
          environmentId: envId,
          isBinary: false,
        },
        select: { id: true, name: true, content: true },
      });

      const results: Array<{
        fileId: string;
        fileName: string;
        success: boolean;
        replacements: number;
        error?: string;
      }> = [];

      for (const file of configFiles) {
        try {
          const oldContent = file.content;
          const { newContent, replacements } = substituteFullValue(oldContent, value, placeholder);

          if (replacements === 0) {
            results.push({
              fileId: file.id,
              fileName: file.name,
              success: true,
              replacements: 0,
            });
            continue;
          }

          // Save previous content to history
          await prisma.fileHistory.create({
            data: {
              content: oldContent,
              configFileId: file.id,
              editedById,
            },
          });

          // Update file content
          const updated = await prisma.configFile.update({
            where: { id: file.id },
            data: { content: newContent },
          });

          // Content changed — re-sync Secret/VarUsage rows so the secrets/vars
          // list endpoints see the newly-substituted placeholder.
          await syncUsageForConfigFile(prisma, updated);

          await logAudit({
            action: 'update',
            resourceType: 'config_file',
            resourceId: file.id,
            resourceName: file.name,
            details: {
              source: 'config_scan',
              key,
              replacements,
            },
            ...actor,
            environmentId: envId,
          });

          results.push({
            fileId: file.id,
            fileName: file.name,
            success: true,
            replacements,
          });
        } catch (error) {
          results.push({
            fileId: file.id,
            fileName: file.name,
            success: false,
            replacements: 0,
            error: getErrorMessage(error, 'Failed to update file'),
          });
        }
      }

      return {
        secretOrVarId,
        key,
        type,
        results,
      };
    }
  );
}
