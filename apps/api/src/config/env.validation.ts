import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  MONGODB_URI!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters' })
  JWT_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  PORT?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsOptional()
  @IsString()
  GITHUB_TOKEN?: string;

  @IsOptional()
  @IsString()
  SCAN_MAX_REPOS?: string;

  @IsOptional()
  @IsString()
  SCAN_MAX_FILES_PER_REPO?: string;

  @IsOptional()
  @IsString()
  SCAN_MAX_FILE_SIZE?: string;

  @IsOptional()
  @IsString()
  SEARCH_BATCH_SIZE?: string;

  @IsOptional()
  @IsBooleanString()
  ENABLE_GIT_HISTORY_SCAN?: string;

  @IsOptional()
  @IsString()
  GIT_HISTORY_MAX_COMMITS?: string;

  @IsOptional()
  @IsBooleanString()
  ENABLE_CLONE_SCAN?: string;

  @IsOptional()
  @IsString()
  CLONE_SCAN_MAX_REPO_SIZE_KB?: string;

  @IsOptional()
  @IsString()
  CLONE_SCAN_TIMEOUT_MS?: string;

  @IsOptional()
  @IsString()
  CLONE_SCAN_MAX_FILES?: string;

  @IsOptional()
  @IsBooleanString()
  AUTO_PROMOTE_KEYWORDS?: string;

  @IsOptional()
  @MinLength(16, {
    message: 'TOKEN_ENCRYPTION_KEY must be at least 16 characters',
  })
  TOKEN_ENCRYPTION_KEY?: string;

  @IsOptional()
  @IsString()
  MAX_CONCURRENT_REQUESTS?: string;

  @IsOptional()
  @IsString()
  GITHUB_MAX_FILE_BYTES?: string;

  @IsOptional()
  @IsBooleanString()
  SEED_ON_BOOT?: string;

  @IsOptional()
  @IsString()
  SEED_DEMO_EMAIL?: string;

  @IsOptional()
  @IsString()
  SEED_DEMO_PASSWORD?: string;

  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @IsString()
  REDIS_HOST?: string;

  @IsOptional()
  @IsString()
  REDIS_PORT?: string;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsOptional()
  @IsString()
  ENABLE_QUEUE_WORKERS?: string;

  @IsOptional()
  @IsString()
  WORKER_CONCURRENCY_ORCHESTRATOR?: string;

  @IsOptional()
  @IsString()
  WORKER_CONCURRENCY_GITHUB_SEARCH?: string;

  @IsOptional()
  @IsString()
  WORKER_CONCURRENCY_REPO_ANALYSIS?: string;

  @IsOptional()
  @IsString()
  WORKER_CONCURRENCY_DETECTION?: string;

  @IsOptional()
  @IsString()
  WORKER_CONCURRENCY_ALERT?: string;

  @IsOptional()
  @IsString()
  QUEUE_JOB_ATTEMPTS?: string;

  @IsOptional()
  @IsString()
  QUEUE_BACKOFF_MS?: string;

  @IsOptional()
  @IsString()
  QUEUE_JOB_TIMEOUT_MS?: string;

  @IsOptional()
  @IsString()
  QUEUE_STALLED_INTERVAL_MS?: string;

  @IsOptional()
  @IsString()
  QUEUE_DRAIN_DELAY_MS?: string;

  @IsOptional()
  @IsString()
  SCAN_PROGRESS_THROTTLE_MS?: string;

  @IsOptional()
  @IsString()
  GITHUB_REQUEST_TIMEOUT_MS?: string;

  @IsOptional()
  @IsString()
  GITHUB_RETRY_ATTEMPTS?: string;

  @IsOptional()
  @IsString()
  GITHUB_RETRY_BACKOFF_MS?: string;

  @IsOptional()
  @IsString()
  GITHUB_RETRY_BACKOFF_MAX_MS?: string;

  @IsOptional()
  @IsString()
  GITHUB_RATE_LIMIT_LOW?: string;

  @IsOptional()
  @IsString()
  GITHUB_RATE_LIMIT_PAUSE_AT?: string;

  @IsOptional()
  @IsString()
  GITHUB_WORKSPACE_DAILY_BUDGET?: string;

  @IsOptional()
  @IsString()
  GITHUB_WORKSPACE_MAX_CONCURRENCY?: string;

  @IsOptional()
  @IsString()
  GITHUB_GLOBAL_MAX_CONCURRENCY?: string;

  @IsOptional()
  @IsString()
  GITHUB_MAX_INLINE_WAIT_MS?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const messages = errors
      .map((e) => Object.values(e.constraints || {}).join(', '))
      .join('; ');
    throw new Error(`Environment validation failed: ${messages}`);
  }
  return validated;
}
