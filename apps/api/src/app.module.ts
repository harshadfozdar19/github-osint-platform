import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BrandsModule } from './brands/brands.module';
import { FindingsModule } from './findings/findings.module';
import { ScansModule } from './scans/scans.module';
import { AlertsModule } from './alerts/alerts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DetectionModule } from './detection/detection.module';
import { GitHubModule } from './github/github.module';
import { SeedModule } from './seed/seed.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { HealthController } from './health/health.controller';
import { KeywordsModule } from './keywords/keywords.module';
import { FingerprintsModule } from './fingerprints/fingerprints.module';
import { ContributorsModule } from './contributors/contributors.module';
import { AppController } from './app.controller';

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
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    UsersModule,
    WorkspacesModule,
    AuthModule,
    BrandsModule,
    FindingsModule,
    ScansModule,
    AlertsModule,
    DashboardModule,
    DetectionModule,
    GitHubModule,
    SeedModule,
    KeywordsModule,
    FingerprintsModule,
    ContributorsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
