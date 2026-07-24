import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { validateEnv } from './config/env.validation';
import { QueuesModule } from './queues/queues.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { BrandsModule } from './brands/brands.module';
import { DetectionModule } from './detection/detection.module';
import { GitHubModule } from './github/github.module';
import { AlertsModule } from './alerts/alerts.module';

/**
 * Dedicated worker application — processes BullMQ scan queues.
 * Run separately from the HTTP API in production:
 *   npm run start:worker
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
      }),
    }),
    UsersModule,
    WorkspacesModule,
    BrandsModule,
    DetectionModule,
    GitHubModule,
    AlertsModule,
    QueuesModule.forWorker(),
  ],
})
export class WorkerModule {}
