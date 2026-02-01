import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

// AES-256-GCM: 32-byte key, 12-byte IV, 16-byte auth tag
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

let masterKey: Buffer | null = null;

export function initializeCrypto(base64Key: string): void {
  const key = Buffer.from(base64Key, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(`Master key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  masterKey = key;
}

function getMasterKey(): Buffer {
  if (!masterKey) {
    throw new Error('Crypto not initialized. Call initializeCrypto first.');
  }
  return masterKey;
}

export function encrypt(plaintext: string): { ciphertext: string; nonce: string } {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Store ciphertext + authTag together
  const combined = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: combined.toString('base64'),
    nonce: iv.toString('base64'),
  };
}

export function decrypt(ciphertext: string, nonce: string): string {
  const key = getMasterKey();
  const combined = Buffer.from(ciphertext, 'base64');
  const iv = Buffer.from(nonce, 'base64');

  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid nonce length: expected ${IV_BYTES}, got ${iv.length}`);
  }

  // Split ciphertext and auth tag
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed - invalid ciphertext or key');
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
