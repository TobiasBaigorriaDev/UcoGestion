import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';

import { MetricsService } from './core/observability/metrics.service.js';
import { DatabaseReadinessService } from './database-readiness.service.js';
import { PublicRoute } from './modules/auth/public-route.decorator.js';

@Controller()
@PublicRoute()
export class AppController {
  constructor(
    private readonly databaseReadiness: DatabaseReadinessService,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  getDescriptor() {
    return {
      service: 'uconext-api',
      version: 'v1',
    };
  }

  @Get('health/live')
  getLiveness() {
    return { status: 'live' };
  }

  @Get('health/ready')
  async getReadiness() {
    const ready = await this.databaseReadiness.isReady();
    this.metrics.recordDatabaseReadiness(ready);
    if (!ready) {
      throw new ServiceUnavailableException('PostgreSQL is not ready');
    }

    return {
      database: 'ready',
      status: 'ready',
    };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    this.metrics.recordDatabaseReadiness(await this.databaseReadiness.isReady());
    return this.metrics.render();
  }
}
