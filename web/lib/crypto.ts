// ============================================================================
// web/lib/crypto.ts — AES-256-GCM helpers for the Next.js server runtime.
// Same algorithm as bot/src/shared/crypto.ts — duplicated to keep the web
// app independent of the bot's TypeScript output. They MUST stay in sync.
// ============================================================================

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedPayload {
  cipher: string;
  iv: string;
  tag: string;
}

function loadMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}`);
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  if (!plaintext) throw new Error("plaintext is empty");
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(p: EncryptedPayload): string {
  const key = loadMasterKey();
  const d = createDecipheriv(ALGO, key, Buffer.from(p.iv, "base64"));
  d.setAuthTag(Buffer.from(p.tag, "base64"));
  const dec = Buffer.concat([d.update(Buffer.from(p.cipher, "base64")), d.final()]);
  return dec.toString("utf8");
}
