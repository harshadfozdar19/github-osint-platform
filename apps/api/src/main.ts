import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const config = app.get(ConfigService);
  const port = Number(config.get('PORT') || 4000);
  const corsOrigin =
    config.get<string>('CORS_ORIGIN') || 'http://localhost:3000';

  app.use(helmet());
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '/', method: RequestMethod.GET }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('GitHub OSINT Threat Intelligence API')
    .setDescription(
      'Defensive OSINT platform for monitoring public GitHub repositories for credential exposure, brand impersonation, phishing kits, and related threats. Tenant-scoped routes require the X-Workspace-Id header; membership is verified on every request.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Workspace-Id',
        description: 'Active workspace ID (membership verified server-side)',
      },
      'workspace',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);

  console.log(`API listening on http://localhost:${port}`);

  console.log(`Swagger docs at http://localhost:${port}/api/docs`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
