import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // structured-ish default logger; swap for a real logger service if needed
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // Reject/strip unknown properties and coerce primitives on all incoming
  // DTOs (both REST controllers and GraphQL input types honor this globally).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const corsOrigin = process.env.CORS_ORIGIN ?? '*';
  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  const port = Number(process.env.PORT) || 4000;
  await app.listen(port);
  Logger.log(`🚀 API listening on http://localhost:${port}/graphql`, 'Bootstrap');
}

bootstrap();
