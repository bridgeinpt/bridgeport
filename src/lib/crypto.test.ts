import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt, initializeCrypto, hashToken, generateToken, generateMasterKey } from './crypto.js';

describe('crypto', () => {
  // initializeCrypto is called via test/setup.ts env + config, but we call it
  // explicitly here with the test key to be self-contained.
  beforeAll(() => {
    initializeCrypto(process.env.MASTER_KEY!);
  });

  describe('encrypt/decrypt round-trip', () => {
    it('should round-trip a normal string', () => {
      const plaintext = 'my-secret-value';
      const { ciphertext, nonce } = encrypt(plaintext);
      expect(decrypt(ciphertext, nonce)).toBe(plaintext);
    });

    it('should handle empty string', () => {
      const { ciphertext, nonce } = encrypt('');
      expect(decrypt(ciphertext, nonce)).toBe('');
    });

    it('should handle a large payload', () => {
      const plaintext = 'A'.repeat(100_000);
      const { ciphertext, nonce } = encrypt(plaintext);
      expect(decrypt(ciphertext, nonce)).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = 'hello world';
      const { ciphertext, nonce } = encrypt(plaintext);
      expect(decrypt(ciphertext, nonce)).toBe(plaintext);
    });

    it('should handle special characters and JSON', () => {
      const plaintext = JSON.stringify({ password: "p@ss'w\"ord!", nested: { key: 'value' } });
      const { ciphertext, nonce } = encrypt(plaintext);
      expect(decrypt(ciphertext, nonce)).toBe(plaintext);
    });
  });

  describe('nonce uniqueness', () => {
    it('should produce different ciphertexts for the same input', () => {
      const { ciphertext: ct1, nonce: n1 } = encrypt('same-input');
      const { ciphertext: ct2, nonce: n2 } = encrypt('same-input');
      expect(ct1).not.toBe(ct2);
      expect(n1).not.toBe(n2);
    });

    it('should produce unique nonces across many encryptions', () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { nonce } = encrypt('test');
        nonces.add(nonce);
      }
      expect(nonces.size).toBe(100);
    });
  });

  describe('tampered ciphertext rejection', () => {
    it('should reject tampered ciphertext', () => {
      const { ciphertext, nonce } = encrypt('secret');
      const tampered = ciphertext.slice(0, -2) + 'xx';
      expect(() => decrypt(tampered, nonce)).toThrow('Decryption failed');
    });

    it('should reject wrong nonce', () => {
      const { ciphertext } = encrypt('secret');
      const { nonce: wrongNonce } = encrypt('other');
      expect(() => decrypt(ciphertext, wrongNonce)).toThrow('Decryption failed');
    });

    it('should reject invalid nonce length', () => {
      const { ciphertext } = encrypt('secret');
      const shortNonce = Buffer.from('short').toString('base64');
      expect(() => decrypt(ciphertext, shortNonce)).toThrow('Invalid nonce length');
    });

    it('should reject completely empty ciphertext', () => {
      const { nonce } = encrypt('secret');
      // Empty base64 means empty buffer - auth tag will be missing
      expect(() => decrypt('', nonce)).toThrow();
    });
  });

  describe('wrong key rejection', () => {
    it('should reject decryption after reinitializing with a different key', () => {
      const { ciphertext, nonce } = encrypt('secret');

      // Re-init with a different key
      const differentKey = generateMasterKey();
      initializeCrypto(differentKey);

      expect(() => decrypt(ciphertext, nonce)).toThrow('Decryption failed');

      // Restore original key for other tests
      initializeCrypto(process.env.MASTER_KEY!);
    });
  });

  describe('initializeCrypto', () => {
    it('should reject a key that is not 32 bytes', () => {
      const shortKey = Buffer.from('tooshort').toString('base64');
      expect(() => initializeCrypto(shortKey)).toThrow('Master key must be 32 bytes');
    });

    it('should accept a valid 32-byte key', () => {
      const validKey = generateMasterKey();
      expect(() => initializeCrypto(validKey)).not.toThrow();
      // Restore
      initializeCrypto(process.env.MASTER_KEY!);
    });
  });

  describe('hashToken', () => {
    it('should return a consistent hash for the same input', () => {
      const hash1 = hashToken('my-token');
      const hash2 = hashToken('my-token');
      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different inputs', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      expect(hash1).not.toBe(hash2);
    });

    it('should return a base64-encoded string', () => {
      const hash = hashToken('test');
      // base64 characters: A-Z, a-z, 0-9, +, /, =
      expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('generateToken', () => {
    it('should return a base64url-encoded string', () => {
      const token = generateToken();
      // base64url: A-Z, a-z, 0-9, -, _
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(50);
    });

    it('should generate tokens of consistent length', () => {
      const token = generateToken();
      // 32 bytes -> base64url is 43 chars
      expect(token.length).toBe(43);
    });
  });

  describe('generateMasterKey', () => {
    it('should return a base64-encoded 32-byte key', () => {
      const key = generateMasterKey();
      const decoded = Buffer.from(key, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const key1 = generateMasterKey();
      const key2 = generateMasterKey();
      expect(key1).not.toBe(key2);
    });
  });
});
