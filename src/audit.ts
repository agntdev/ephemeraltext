import { Redis } from "ioredis";
import { getRedis } from "./redis.js";

// Append-only audit log of admin actions. Entries NEVER contain message
// plaintext — only the action, a hashed operator id, an optional target token,
// and a timestamp. Production stores the log in Redis; dev/tests use an
// in-process list.

export interface AuditEntry {
  action: string; // e.g. "delete", "metrics", "logs"
  operator: string; // hashed admin id (never the raw id)
  target?: string; // e.g. a message token; never plaintext
  at: number; // ms since epoch
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  recent(limit: number): Promise<AuditEntry[]>;
}

const LOG_KEY = "audit:log";
const MAX_ENTRIES = 1000;

/** Redis-backed audit log (capped list, newest first). */
export class RedisAuditLog implements AuditLog {
  constructor(private readonly redis: Redis) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.redis.lpush(LOG_KEY, JSON.stringify(entry));
    await this.redis.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    const raw = await this.redis.lrange(LOG_KEY, 0, Math.max(0, limit - 1));
    return raw.map((r) => JSON.parse(r) as AuditEntry);
  }
}

/** In-process audit log for local dev and the tokenless test harness only. */
export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(0, Math.max(0, limit));
  }
}

/** Pick the audit log backend based on the runtime environment. */
export function createAuditLog(): AuditLog {
  const redis = getRedis();
  if (redis) {
    return new RedisAuditLog(redis);
  }
  return new MemoryAuditLog();
}
