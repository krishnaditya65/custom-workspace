import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT } from './redis.constants';

/**
 * API-side Redis helper.
 *
 * IMPORTANT scope note: this service is for lightweight, ephemeral, API-side
 * concerns only - rate-limit counters (via RedisThrottlerStorage), typing
 * indicators, and presence pings that are cheap to lose and don't need
 * durability. It is NOT the CRDT/document sync channel.
 *
 * The realtime WebSocket sync engine (apps/sync, built separately) owns
 * Yjs/CRDT awareness state and cross-instance document broadcast over its
 * own Redis pub/sub channels. Do not repurpose this service for document
 * collaboration traffic - keep the two concerns on separate channel
 * namespaces (this service prefixes its channels with `api:`) so the two
 * services never collide.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT) public readonly client: Redis,
    @Inject(REDIS_SUBSCRIBER_CLIENT) public readonly subscriber: Redis,
  ) {}

  private channel(name: string): string {
    return `api:${name}`;
  }

  /** Publish an ephemeral event (e.g. typing indicator, presence ping). */
  async publish(channel: string, payload: unknown): Promise<void> {
    await this.client.publish(this.channel(channel), JSON.stringify(payload));
  }

  /**
   * Subscribe to an ephemeral event channel. Uses a dedicated subscriber
   * connection because ioredis puts a client into subscriber mode, which
   * cannot also issue regular commands.
   */
  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const fullChannel = this.channel(channel);
    await this.subscriber.subscribe(fullChannel);
    this.subscriber.on('message', (incomingChannel, message) => {
      if (incomingChannel !== fullChannel) return;
      try {
        handler(JSON.parse(message));
      } catch (err) {
        this.logger.warn(`Failed to parse pub/sub payload on ${fullChannel}: ${err}`);
      }
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
    this.subscriber.disconnect();
  }
}
