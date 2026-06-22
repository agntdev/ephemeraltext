import { Redis } from "ioredis";
import { hashSenderId } from "./identity.js";

// Per-user upload rate limiting. Counters must survive restarts, so production
// keeps them in Redis (REDIS_URL). The tokenless test harness and local dev have
// no Redis, so an in-process backend is used there — production ALWAYS sets
// REDIS_URL, so the in-process backend is never the production store.

/** Sliding-window event counter keyed by an opaque string. */
export interface RateLimitBackend {
  /**
   * Record one event for `key` at time `now` (ms) and return how many events
   * for that key fall within the trailing `windowMs`.
   */
  hit(key: string, now: number, windowMs: number): Promise<number>;
}

/** Redis-backed backend using a sorted set of event timestamps per key. */
export class RedisRateLimitBackend implements RateLimitBackend {
  private seq = 0;

  constructor(private readonly redis: Redis) {}

  async hit(key: string, now: number, windowMs: number): Promise<number> {
    const cutoff = now - windowMs;
    // Unique member per event (timestamps can collide within the same ms).
    const member = `${now}:${this.seq++}`;
    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(key, 0, cutoff); // drop events outside the window
    pipeline.zadd(key, now, member); // record this event
    pipeline.zcard(key); // count events in the window
    pipeline.pexpire(key, windowMs); // let idle keys expire
    const results = await pipeline.exec();
    // zcard is the third command; results entries are [err, value] tuples.
    const count = results?.[2]?.[1];
    return typeof count === "number" ? count : Number(count ?? 0);
  }
}

/** In-process backend for local dev and the tokenless test harness only. */
export class MemoryRateLimitBackend implements RateLimitBackend {
  private readonly events = new Map<string, number[]>();

  async hit(key: string, now: number, windowMs: number): Promise<number> {
    const cutoff = now - windowMs;
    const kept = (this.events.get(key) ?? []).filter((t) => t > cutoff);
    kept.push(now);
    this.events.set(key, kept);
    return kept.length;
  }
}

/** Pick the backend based on the runtime environment. */
export function createRateLimitBackend(): RateLimitBackend {
  const url = process.env.REDIS_URL;
  if (url) {
    return new RedisRateLimitBackend(new Redis(url));
  }
  return new MemoryRateLimitBackend();
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  /** Redis key namespace (e.g. "upload", "admin"). */
  namespace: string;
}

/** Enforces "at most `max` events per `windowMs`" per hashed sender id. */
export class RateLimiter {
  constructor(
    private readonly backend: RateLimitBackend,
    private readonly options: RateLimiterOptions,
  ) {}

  /** Record an attempt; returns true if it is within the limit. */
  async allow(senderId: number, now: number = Date.now()): Promise<boolean> {
    const key = `ratelimit:${this.options.namespace}:${hashSenderId(senderId)}`;
    const count = await this.backend.hit(key, now, this.options.windowMs);
    return count <= this.options.max;
  }
}
