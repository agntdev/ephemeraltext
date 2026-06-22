import { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";
import type { ExpiryMode } from "./types.js";
import type { EncryptedPayload } from "./crypto.js";
import type { WrappedDataKey } from "./kms.js";
import { getRedis } from "./redis.js";

// Durable storage for shared ephemeral messages, keyed by their public token.
// Production uses Redis (REDIS_URL); local dev and the tokenless test harness use
// an in-process map fallback — production ALWAYS sets REDIS_URL, so the fallback
// is never the production store.

// The persisted Message entity. The schema is store-agnostic: the Redis backend
// keeps one JSON document per public token; a SQL backend would map these fields
// to columns of a `messages` table (public_token UNIQUE, encrypted_payload JSONB,
// mode, created_at, expires_at, read_count, …).
export interface Message {
  // Internal unique id (primary key).
  id: string;
  // Public, high-entropy token used in the share link (unique lookup key).
  publicToken: string;
  // The message text, encrypted under its own per-message data key.
  encryptedPayload: EncryptedPayload;
  // The per-message data key, wrapped by the KMS master key (envelope encryption).
  wrappedDataKey: WrappedDataKey;
  // How the message expires.
  mode: ExpiryMode;
  // Creation time (ms since epoch).
  createdAt: number;
  // Absolute expiry (ms since epoch) for time-limited messages; null otherwise.
  expiresAt: number | null;
  // Number of successful reads so far.
  readCount: number;
}

/** Build a new Message entity from the sealed-draft inputs. */
export function newMessage(fields: {
  publicToken: string;
  encryptedPayload: EncryptedPayload;
  wrappedDataKey: WrappedDataKey;
  mode: ExpiryMode;
  createdAt: number;
  expiresAt?: number | null;
}): Message {
  return {
    id: randomUUID(),
    publicToken: fields.publicToken,
    encryptedPayload: fields.encryptedPayload,
    wrappedDataKey: fields.wrappedDataKey,
    mode: fields.mode,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt ?? null,
    readCount: 0,
  };
}

export interface MessageStore {
  // ttlSeconds, when given, schedules automatic deletion of the record so even
  // never-read messages are eventually purged.
  save(message: Message, ttlSeconds?: number): Promise<void>;
  load(publicToken: string): Promise<Message | null>;
  delete(publicToken: string): Promise<void>;
  // Number of messages currently stored (for admin metrics).
  count(): Promise<number>;
}

const keyFor = (token: string) => `message:${token}`;

/** Redis-backed store: one JSON document per message token. */
export class RedisMessageStore implements MessageStore {
  constructor(private readonly redis: Redis) {}

  async save(message: Message, ttlSeconds?: number): Promise<void> {
    const key = keyFor(message.publicToken);
    const value = JSON.stringify(message);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, value, "EX", Math.ceil(ttlSeconds));
    } else {
      await this.redis.set(key, value);
    }
  }

  async load(publicToken: string): Promise<Message | null> {
    const raw = await this.redis.get(keyFor(publicToken));
    return raw ? (JSON.parse(raw) as Message) : null;
  }

  async delete(publicToken: string): Promise<void> {
    await this.redis.del(keyFor(publicToken));
  }

  async count(): Promise<number> {
    let cursor = "0";
    let total = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        keyFor("*"),
        "COUNT",
        100,
      );
      cursor = next;
      total += keys.length;
    } while (cursor !== "0");
    return total;
  }
}

/** In-process store for local dev and the tokenless test harness only. */
export class MemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, Message>();

  // The in-process fallback does not enforce TTL (no background expiry); the
  // read path still rejects expired messages. Production (Redis) honors the TTL.
  async save(message: Message, _ttlSeconds?: number): Promise<void> {
    this.messages.set(keyFor(message.publicToken), message);
  }

  async load(publicToken: string): Promise<Message | null> {
    return this.messages.get(keyFor(publicToken)) ?? null;
  }

  async delete(publicToken: string): Promise<void> {
    this.messages.delete(keyFor(publicToken));
  }

  async count(): Promise<number> {
    return this.messages.size;
  }
}

/** Pick the store based on the runtime environment. */
export function createMessageStore(): MessageStore {
  const redis = getRedis();
  if (redis) {
    return new RedisMessageStore(redis);
  }
  return new MemoryMessageStore();
}

// Public tokens are 22 characters drawn from a 64-symbol URL-safe alphabet, i.e.
// 22 * log2(64) = 132 bits of entropy — large enough to make guessing a valid
// token infeasible.
const TOKEN_LENGTH = 22;
const URL_SAFE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Generate a 22-character, URL-safe public token (~132 bits of entropy). */
export function generatePublicToken(): string {
  // 256 % 64 === 0, so masking each random byte with & 63 selects uniformly from
  // the 64-symbol alphabet with no modulo bias.
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += URL_SAFE_ALPHABET[bytes[i] & 63];
  }
  return token;
}

// A valid token is URL-safe (A-Za-z0-9_-). New tokens are 22 chars; the range
// also accepts the slightly longer tokens minted before this change.
const TOKEN_RE = /^[A-Za-z0-9_-]{22,24}$/;

/** True if `token` has the shape of a public token (cheap pre-lookup check). */
export function isValidPublicToken(token: string): boolean {
  return TOKEN_RE.test(token);
}
