import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { renderTemplate } from './template-engine.js';
import { listServersForTemplate } from './servers.js';

export interface SecretInput {
  key: string;
  value: string;
  description?: string;
  neverReveal?: boolean;
}

export interface SecretOutput {
  id: string;
  key: string;
  description: string | null;
  neverReveal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function createSecret(
  environmentId: string,
  input: SecretInput
): Promise<SecretOutput> {
  const { ciphertext, nonce } = encrypt(input.value);

  const secret = await prisma.secret.create({
    data: {
      key: input.key,
      encryptedValue: ciphertext,
      nonce,
      description: input.description,
      neverReveal: input.neverReveal ?? false,
      environmentId,
    },
    select: {
      id: true,
      key: true,
      description: true,
      neverReveal: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return secret;
}

export async function updateSecret(
  secretId: string,
  input: Partial<SecretInput>
): Promise<SecretOutput> {
  const updateData: {
    encryptedValue?: string;
    nonce?: string;
    description?: string;
    neverReveal?: boolean;
  } = {};

  if (input.value !== undefined) {
    const { ciphertext, nonce } = encrypt(input.value);
    updateData.encryptedValue = ciphertext;
    updateData.nonce = nonce;
  }

  if (input.description !== undefined) {
    updateData.description = input.description;
  }

  if (input.neverReveal !== undefined) {
    updateData.neverReveal = input.neverReveal;
  }

  const secret = await prisma.secret.update({
    where: { id: secretId },
    data: updateData,
    select: {
      id: true,
      key: true,
      description: true,
      neverReveal: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return secret;
}

export async function getSecretValue(secretId: string): Promise<string> {
  const secret = await prisma.secret.findUniqueOrThrow({
    where: { id: secretId },
  });

  return decrypt(secret.encryptedValue, secret.nonce);
}

export async function listSecrets(environmentId: string): Promise<SecretOutput[]> {
  return prisma.secret.findMany({
    where: { environmentId },
    select: {
      id: true,
      key: true,
      description: true,
      neverReveal: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { key: 'asc' },
  });
}

export async function deleteSecret(secretId: string): Promise<void> {
  await prisma.secret.delete({
    where: { id: secretId },
  });
}

export async function getSecretsForEnv(
  environmentId: string
): Promise<Record<string, string>> {
  const secrets = await prisma.secret.findMany({
    where: { environmentId },
  });

  const result: Record<string, string> = {};
  for (const secret of secrets) {
    result[secret.key] = decrypt(secret.encryptedValue, secret.nonce);
  }

  return result;
}

/**
 * Get all vars for an environment as a key-value map.
 */
export async function getVarsForEnv(
  environmentId: string
): Promise<Record<string, string>> {
  const vars = await prisma.var.findMany({
    where: { environmentId },
  });

  const result: Record<string, string> = {};
  for (const v of vars) {
    result[v.key] = v.value;
  }
  return result;
}

/**
 * Resolve placeholders in a config-file template:
 *   1. Server iteration: `{{range servers ...}}...{{end}}` blocks render first.
 *   2. Variable / secret substitution: `${KEY}` then replaces (vars first,
 *      secrets win on conflict).
 *
 * Returns the rendered content, any missing `${KEY}` references, and any
 * template-engine errors (malformed range, unknown filter, unknown field,
 * unclosed/nested range, etc).
 */
export async function resolveSecretPlaceholders(
  environmentId: string,
  content: string
): Promise<{ content: string; missing: string[]; templateErrors: string[] }> {
  // Stage 1: server iteration. Pure function over the content + a server lookup.
  const { content: templateContent, errors: templateErrors } = await renderTemplate(content, {
    currentEnvironmentId: environmentId,
    listServers: (filters) => listServersForTemplate(environmentId, filters),
  });

  // Stage 2: ${KEY} substitution. Same semantics as before.
  const [secrets, vars] = await Promise.all([
    getSecretsForEnv(environmentId),
    getVarsForEnv(environmentId),
  ]);

  let resolvedContent = templateContent;

  // Resolve vars first. Use the function-replacement form so `$`, `$&`, `$1`
  // etc. in the value are preserved literally instead of being interpreted as
  // String.replace replacement patterns (e.g. a secret like `pa$$word`).
  for (const [key, value] of Object.entries(vars)) {
    resolvedContent = resolvedContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), () => value);
  }

  // Then resolve secrets (overrides vars if same key)
  for (const [key, value] of Object.entries(secrets)) {
    resolvedContent = resolvedContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), () => value);
  }

  // Find any remaining unresolved placeholders
  const unresolved = resolvedContent.match(/\$\{[A-Z_][A-Z0-9_]*\}/g) || [];
  const missing = [...new Set(unresolved)].map((p) => p.slice(2, -1)); // Remove ${ and }

  return { content: resolvedContent, missing, templateErrors };
}
