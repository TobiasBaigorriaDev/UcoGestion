import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';

import { MetricsService } from './core/observability/metrics.service.js';
import { DatabaseReadinessService } from './database-readiness.service.js';

@Controller()
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
    if (!(await this.databaseReadiness.isReady())) {
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
    return this.metrics.render();
  }
}
