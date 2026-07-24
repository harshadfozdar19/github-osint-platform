import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('Worker');
  // Force workers on in this process
  process.env.ENABLE_QUEUE_WORKERS = 'true';

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'error', 'warn'],
  });

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down workers gracefully…`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.log('BullMQ scan workers are running');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
