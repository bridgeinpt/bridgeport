import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';

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
 * Resolve ${SECRET_KEY} placeholders in content with actual secret values.
 * Returns the resolved content and any missing secrets.
 */
export async function resolveSecretPlaceholders(
  environmentId: string,
  content: string
): Promise<{ content: string; missing: string[] }> {
  const secrets = await getSecretsForEnv(environmentId);

  let resolvedContent = content;

  for (const [key, value] of Object.entries(secrets)) {
    resolvedContent = resolvedContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
  }

  // Find any remaining unresolved placeholders
  const unresolved = resolvedContent.match(/\$\{[A-Z_][A-Z0-9_]*\}/g) || [];
  const missing = [...new Set(unresolved)].map((p) => p.slice(2, -1)); // Remove ${ and }

  return { content: resolvedContent, missing };
}
