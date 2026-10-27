import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

/**
 * Mirrors @nestjs/throttler's internal ThrottlerStorageRecord shape. Defined
 * locally rather than deep-importing from the package's dist/ (which is not
 * part of its public "exports" surface and could move between versions).
 */
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed ThrottlerStorage implementation.
 *
 * @nestjs/throttler's default storage is an in-memory Map, which does not
 * work correctly once the API is scaled to more than one instance (each
 * instance would track its own independent counters, defeating the rate
 * limit). This class persists hit counters in Redis instead, keyed per
 * tracker+TTL bucket, so all instances share the same limit.
 *
 * Implementation notes:
 *  - We use a single Redis key per (throttler-name, tracker) pair and store
 *    the current hit count as the value, relying on Redis TTL for expiry.
 *  - `INCR` + conditional `EXPIRE` (only set TTL on the first hit) keeps this
 *    to two round trips without needing Lua, which is simple enough given
 *    the low request volume relative to Redis throughput. For extremely
 *    high QPS you'd replace this with a single EVAL script for atomicity;
 *    documented here as a known scaling knob rather than solved prematurely.
 *  - `blockDuration` support: if a tracker exceeds the limit, we additionally
 *    set a `block:<key>` marker for `blockDuration` ms so subsequent calls
 *    short-circuit as blocked even after the counting window rolls over.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  private key(prefix: string): string {
    return `throttle:${prefix}`;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = this.key(`${throttlerName}:${key}`);
    const blockKey = this.key(`${throttlerName}:${key}:blocked`);

    const isBlocked = await this.redis.get(blockKey);
    if (isBlocked) {
      const blockTtlMs = await this.redis.pttl(blockKey);
      return {
        totalHits: limit + 1,
        timeToExpire: Math.ceil((await this.redis.pttl(redisKey)) / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.max(0, Math.ceil(blockTtlMs / 1000)),
      };
    }

    const totalHits = await this.redis.incr(redisKey);
    if (totalHits === 1) {
      // First hit in this window - start the TTL countdown (ttl is ms).
      await this.redis.pexpire(redisKey, ttl);
    }

    const timeToExpireMs = await this.redis.pttl(redisKey);
    const blocked = totalHits > limit;

    if (blocked && blockDuration > 0) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration);
    }

    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(timeToExpireMs / 1000)),
      isBlocked: blocked,
      timeToBlockExpire: blocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }
}
