import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const KEY = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64");

export interface Encrypted {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** AES-256-GCM encryption for credentials stored at rest. */
export function encryptSecret(plain: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(e: Encrypted): string {
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** Shows only the last 4 characters of a secret, e.g. "••••abcd". */
export function maskSecret(plain: string): string {
  return plain.length <= 4 ? "••••" : `••••${plain.slice(-4)}`;
}
