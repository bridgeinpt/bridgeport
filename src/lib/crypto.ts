import sodium from 'sodium-native';

const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES; // 24 bytes for XChaCha20
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES; // 32 bytes
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES; // 16 bytes

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
  const message = Buffer.from(plaintext, 'utf8');

  const nonce = Buffer.alloc(NONCE_BYTES);
  sodium.randombytes_buf(nonce);

  const ciphertext = Buffer.alloc(message.length + MAC_BYTES);
  sodium.crypto_secretbox_easy(ciphertext, message, nonce, key);

  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

export function decrypt(ciphertext: string, nonce: string): string {
  const key = getMasterKey();
  const ciphertextBuf = Buffer.from(ciphertext, 'base64');
  const nonceBuf = Buffer.from(nonce, 'base64');

  if (nonceBuf.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce length: expected ${NONCE_BYTES}, got ${nonceBuf.length}`);
  }

  const plaintext = Buffer.alloc(ciphertextBuf.length - MAC_BYTES);

  const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertextBuf, nonceBuf, key);

  if (!success) {
    throw new Error('Decryption failed - invalid ciphertext or key');
  }

  return plaintext.toString('utf8');
}

export function hashToken(token: string): string {
  const hash = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(hash, Buffer.from(token, 'utf8'));
  return hash.toString('base64');
}

export function generateToken(): string {
  const token = Buffer.alloc(32);
  sodium.randombytes_buf(token);
  return token.toString('base64url');
}

export function generateMasterKey(): string {
  const key = Buffer.alloc(KEY_BYTES);
  sodium.randombytes_buf(key);
  return key.toString('base64');
}
