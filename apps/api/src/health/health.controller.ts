import { Controller, Get, HttpCode } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Plain REST health check (not GraphQL) so infra (load balancers, k8s
 * liveness/readiness probes) can hit it without speaking GraphQL.
 * Deliberately never throws - dependency checks are best-effort and a
 * degraded dependency is reported in the body with a 200, not a 5xx, so the
 * process itself isn't killed just because e.g. Redis had a blip (the
 * caller/orchestrator decides what "degraded" means for restart policy).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @HttpCode(200)
  async check() {
    const [dbHealthy, redisHealthy] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.isHealthy(),
    ]);

    const status = dbHealthy && redisHealthy ? 'ok' : 'degraded';

    return {
      status,
      uptime: process.uptime(),
      dependencies: {
        postgres: dbHealthy ? 'up' : 'down',
        redis: redisHealthy ? 'up' : 'down',
      },
    };
  }
}
