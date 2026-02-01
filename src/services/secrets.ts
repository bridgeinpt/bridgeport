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

export async function generateEnvFile(
  environmentId: string,
  templateName: string
): Promise<string> {
  const template = await prisma.envTemplate.findUnique({
    where: { name: templateName },
  });

  if (!template) {
    throw new Error(`Template not found: ${templateName}`);
  }

  const secrets = await getSecretsForEnv(environmentId);

  // Replace ${SECRET_KEY} placeholders with actual values
  let envContent = template.template;

  for (const [key, value] of Object.entries(secrets)) {
    envContent = envContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
  }

  // Check for any remaining unresolved placeholders
  const unresolved = envContent.match(/\$\{[A-Z_]+\}/g);
  if (unresolved) {
    const missing = [...new Set(unresolved)].join(', ');
    throw new Error(`Missing secrets for template placeholders: ${missing}`);
  }

  return envContent;
}

export interface EnvTemplateOutput {
  id: string;
  name: string;
  template: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function createEnvTemplate(
  name: string,
  template: string
): Promise<EnvTemplateOutput> {
  return prisma.envTemplate.create({
    data: { name, template },
  });
}

export async function updateEnvTemplate(
  name: string,
  template: string
): Promise<EnvTemplateOutput> {
  return prisma.envTemplate.update({
    where: { name },
    data: { template },
  });
}

export async function listEnvTemplates(): Promise<EnvTemplateOutput[]> {
  return prisma.envTemplate.findMany({
    orderBy: { name: 'asc' },
  });
}

export async function getEnvTemplate(name: string): Promise<EnvTemplateOutput | null> {
  return prisma.envTemplate.findUnique({
    where: { name },
  });
}

export async function deleteEnvTemplate(name: string): Promise<void> {
  await prisma.envTemplate.delete({
    where: { name },
  });
}
