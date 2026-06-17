import { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";
import type { ExpiryMode } from "./types.js";
import type { EncryptedPayload } from "./crypto.js";
import type { WrappedDataKey } from "./kms.js";

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

// A valid token is base64url (A-Za-z0-9_-). 17 bytes encode to 23 chars; allow a
// small range so the check is robust to token-size tweaks.
const TOKEN_RE = /^[A-Za-z0-9_-]{22,24}$/;

/** True if `token` has the shape of a public token (cheap pre-lookup check). */
export function isValidPublicToken(token: string): boolean {
  return TOKEN_RE.test(token);
}
