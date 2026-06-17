import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// Authenticated symmetric encryption for message payloads. Each message is
// encrypted under its OWN random data key (envelope encryption): the data key is
// later wrapped by a master key (see KMS integration), so the stored ciphertext
// is useless without unwrapping the per-message key.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

/** Generate a fresh 256-bit data key for a single message. */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Encrypt UTF-8 plaintext with the given data key using AES-256-GCM. */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt an AES-256-GCM payload; throws if the key or auth tag is wrong. */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
