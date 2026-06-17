import { createHmac, randomBytes } from "node:crypto";

// Pseudonymous identifiers for Telegram senders. Raw sender ids are never stored
// or logged; instead we store a keyed HMAC-SHA256 of the id. Using HMAC with a
// secret server key (not a bare hash) makes the digest non-reversible even
// though the id space is small and enumerable — an attacker without the server
// key cannot brute-force the mapping.

// Server HMAC key. Production injects HASH_SERVER_KEY; dev/tests fall back to a
// process-stable random key (consistent within a single run).
const DEV_FALLBACK_KEY = randomBytes(32).toString("hex");

function serverKey(): string {
  return process.env.HASH_SERVER_KEY ?? DEV_FALLBACK_KEY;
}

/** Non-reversible, keyed hash of a Telegram sender id for rate limits and logs. */
export function hashSenderId(id: number | string): string {
  return createHmac("sha256", serverKey()).update(String(id)).digest("hex");
}
