import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';
import { PUB_SUB } from './pubsub.constants';

/**
 * Provides a single RedisPubSub instance (from graphql-redis-subscriptions)
 * used by GraphQL subscription resolvers, e.g. `messageAdded`. Backing this
 * with Redis (rather than the in-memory graphql-subscriptions PubSub) is
 * what lets subscriptions fan out correctly when the API is horizontally
 * scaled across multiple instances - a client subscribed to instance A
 * receives events published from instance B.
 *
 * Uses its own pair of Redis connections (separate from RedisModule's,
 * which are reserved for throttling + ephemeral typing/presence pub/sub) so
 * subscription traffic doesn't compete with / get confused with that
 * unrelated channel namespace.
 */
@Global()
@Module({
  providers: [
    {
      provide: PUB_SUB,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        return new RedisPubSub({
          publisher: new Redis(url),
          subscriber: new Redis(url),
        });
      },
    },
  ],
  exports: [PUB_SUB],
})
export class PubSubModule {}
