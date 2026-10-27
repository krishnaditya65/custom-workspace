import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';
import { join } from 'path';

import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisThrottlerStorage } from './common/throttler-redis.storage';
import { GqlThrottlerGuard } from './common/gql-throttler.guard';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ChannelsModule } from './channels/channels.module';
import { MessagesModule } from './messages/messages.module';
import { TasksModule } from './tasks/tasks.module';
import { CalendarModule } from './calendar/calendar.module';
import { GuestLinksModule } from './guest-links/guest-links.module';
import { HealthModule } from './health/health.module';
import { InternalModule } from './internal/internal.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        autoSchemaFile: join(process.cwd(), 'schema.gql'),
        sortSchema: true,
        playground: config.get('NODE_ENV', 'development') !== 'production',
        introspection: config.get('NODE_ENV', 'development') !== 'production',
        // Enables the `messageAdded` subscription over graphql-ws.
        subscriptions: {
          'graphql-ws': true,
        },
        // Pass both req and res into resolver context so guards (which use
        // GqlExecutionContext -> context.req) and any resolver that needs to
        // set response headers/cookies both work.
        context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
      }),
    }),

    // Redis-backed rate limiting: a single default rule (100 req / 60s per
    // client) applied globally via ThrottlerGuard registered as an APP_GUARD
    // below. Using Redis (RedisThrottlerStorage) rather than the default
    // in-memory storage is what makes this correct once the API runs as
    // more than one instance behind a load balancer.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage(
          new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379')),
        ),
      }),
    }),

    PrismaModule,
    RedisModule,

    AuthModule,
    UsersModule,
    WorkspacesModule,
    ChannelsModule,
    MessagesModule,
    TasksModule,
    CalendarModule,
    GuestLinksModule,
    HealthModule,
    InternalModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: GqlThrottlerGuard,
    },
  ],
})
export class AppModule {}
