import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { ExpiryMode } from "./types.js";
import type { EncryptedPayload } from "./crypto.js";

// Durable storage for shared ephemeral messages, keyed by their public token.
// Production uses Redis (REDIS_URL); local dev and the tokenless test harness use
// an in-process map fallback — production ALWAYS sets REDIS_URL, so the fallback
// is never the production store.

export interface StoredMessage {
  // The message text, encrypted under its own per-message data key.
  payload: EncryptedPayload;
  // The per-message data key, base64. Stored wrapped by the master key once KMS
  // integration lands; held as-is until then.
  dataKey: string;
  mode: ExpiryMode;
  createdAt: number;
}

export interface MessageStore {
  save(token: string, message: StoredMessage): Promise<void>;
  load(token: string): Promise<StoredMessage | null>;
  delete(token: string): Promise<void>;
}

const keyFor = (token: string) => `message:${token}`;

/** Redis-backed store: one JSON value per message token. */
export class RedisMessageStore implements MessageStore {
  constructor(private readonly redis: Redis) {}

  async save(token: string, message: StoredMessage): Promise<void> {
    await this.redis.set(keyFor(token), JSON.stringify(message));
  }

  async load(token: string): Promise<StoredMessage | null> {
    const raw = await this.redis.get(keyFor(token));
    return raw ? (JSON.parse(raw) as StoredMessage) : null;
  }

  async delete(token: string): Promise<void> {
    await this.redis.del(keyFor(token));
  }
}

/** In-process store for local dev and the tokenless test harness only. */
export class MemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage>();

  async save(token: string, message: StoredMessage): Promise<void> {
    this.messages.set(keyFor(token), message);
  }

  async load(token: string): Promise<StoredMessage | null> {
    return this.messages.get(keyFor(token)) ?? null;
  }

  async delete(token: string): Promise<void> {
    this.messages.delete(keyFor(token));
  }
}

/** Pick the store based on the runtime environment. */
export function createMessageStore(): MessageStore {
  const url = process.env.REDIS_URL;
  if (url) {
    return new RedisMessageStore(new Redis(url));
  }
  return new MemoryMessageStore();
}

// A public token carries at least 132 bits of entropy. 17 random bytes are
// 136 bits, encoded URL-safe (base64url → only A-Za-z0-9_- characters).
const TOKEN_BYTES = 17;

/** Generate a high-entropy, URL-safe public token (>= 132 bits). */
export function generatePublicToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}
