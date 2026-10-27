import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Global module providing raw ioredis clients plus the RedisService wrapper.
 * Two separate connections are provided (`REDIS_CLIENT` for commands,
 * `REDIS_SUBSCRIBER_CLIENT` dedicated to pub/sub) because a Redis connection
 * in subscriber mode cannot issue normal commands.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
          maxRetriesPerRequest: null,
        }),
    },
    {
      provide: REDIS_SUBSCRIBER_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
          maxRetriesPerRequest: null,
        }),
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT],
})
export class RedisModule {}
