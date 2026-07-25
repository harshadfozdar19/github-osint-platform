import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

/**
 * Root route. This is an API-only service - everything real lives under
 * /api/v1 - so hitting the bare host URL directly (e.g. checking the Render
 * deploy link) used to 404. A short pointer here is friendlier than a raw
 * 404 for anyone just checking the link is alive.
 */
@ApiExcludeController()
@Controller()
export class AppController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  root() {
    const dashboard = (this.config.get<string>('CORS_ORIGIN') || '')
      .split(',')[0]
      ?.trim();
    return {
      name: 'GitHub OSINT Threat Intelligence API',
      status: 'ok',
      dashboard: dashboard || undefined,
      docs: '/api/docs',
      health: '/api/v1/health',
    };
  }
}
