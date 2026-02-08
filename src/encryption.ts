import { webcrypto } from 'crypto';

const crypto = webcrypto as unknown as Crypto;

let encryptionKey: CryptoKey | null = null;

/**
 * Initialize encryption with a base64-encoded key
 * Key should be 32 bytes (256 bits) encoded as base64
 */
export async function initEncryption(base64Key: string): Promise<void> {
  if (!base64Key) {
    encryptionKey = null;
    return;
  }
  const keyData = Buffer.from(base64Key, 'base64');
  if (keyData.length !== 32) {
    throw new Error(`Encryption key must be exactly 32 bytes (256 bits), got ${keyData.length} bytes`);
  }
  encryptionKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a raw string to base64 (no JSON wrapping)
 */
export async function encryptString(data: string): Promise<string> {
  if (!encryptionKey) {
    throw new Error('Encryption not initialized');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const messageBytes = new TextEncoder().encode(data);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    messageBytes
  );

  // Combine IV + encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt a base64 string back to raw string (no JSON parsing)
 */
export async function decryptString(encryptedBase64: string): Promise<string> {
  if (!encryptionKey) {
    throw new Error('Encryption not initialized');
  }

  const combined = Buffer.from(encryptedBase64, 'base64');

  // Extract IV (first 12 bytes) and encrypted data
  const iv = combined.subarray(0, 12);
  const encryptedData = combined.subarray(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    encryptedData
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Generate a new random encryption key (for setup)
 */
export function generateKey(): string {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(keyBytes).toString('base64');
}
