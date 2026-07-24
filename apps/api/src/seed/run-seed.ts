import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SeedService } from './seed.service';

async function run() {
  process.env.SEED_ON_BOOT = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const seed = app.get(SeedService);
  await seed.seedDemoData();
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
