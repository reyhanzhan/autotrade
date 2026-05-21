// ============================================================================
// crypto.ts — AES-256-GCM application-level encryption for API credentials.
// ----------------------------------------------------------------------------
// Why GCM (not CBC):
//   - GCM is *authenticated*: any tampering with the ciphertext is detected
//     by an auth-tag mismatch (throws on decrypt). CBC is malleable.
//   - GCM needs a unique 96-bit IV per encryption. We generate a fresh random
//     IV each call and store it alongside the ciphertext.
//
// Storage format (in DB): three base64 strings — `cipher`, `iv`, `tag`.
// Master key:           32 random bytes, base64-encoded, in env ENCRYPTION_KEY.
// Losing ENCRYPTION_KEY = unrecoverable loss of all stored secrets.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;          // 96-bit IV is recommended for GCM
const KEY_BYTES = 32;         // AES-256

export interface EncryptedPayload {
  cipher: string;             // base64
  iv: string;                 // base64
  tag: string;                // base64
}

/**
 * Loads the master key from env, validates it is exactly 32 bytes after
 * base64 decoding, and returns a Buffer. Throws on misconfiguration so the
 * process refuses to start with a weak/missing key.
 */
function loadMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `npm run keygen` and put it in .env"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes; got ${key.length}.`
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 plaintext with AES-256-GCM. Returns three base64 strings
 * suitable for direct DB storage. A fresh IV is generated per call — never
 * reuse an (IV, key) pair with GCM.
 */
export function encryptSecret(plaintext: string): EncryptedPayload {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypts a payload produced by `encryptSecret`. Throws if the auth tag
 * does not verify — this is your tamper-detection guarantee.
 */
export function decryptSecret(payload: EncryptedPayload): string {
  const key = loadMasterKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const cipher = Buffer.from(payload.cipher, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Convenience: generate a fresh master key (used by the `keygen` npm script
 * and surfaced here for tests).
 */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
