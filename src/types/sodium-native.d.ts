declare module 'sodium-native' {
  export const crypto_secretbox_NONCEBYTES: number;
  export const crypto_secretbox_KEYBYTES: number;
  export const crypto_secretbox_MACBYTES: number;
  export const crypto_generichash_BYTES: number;

  export function randombytes_buf(buffer: Buffer): void;
  export function crypto_secretbox_easy(
    ciphertext: Buffer,
    message: Buffer,
    nonce: Buffer,
    key: Buffer
  ): void;
  export function crypto_secretbox_open_easy(
    plaintext: Buffer,
    ciphertext: Buffer,
    nonce: Buffer,
    key: Buffer
  ): boolean;
  export function crypto_generichash(
    output: Buffer,
    input: Buffer,
    key?: Buffer
  ): void;
}
