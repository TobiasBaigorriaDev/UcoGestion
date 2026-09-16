import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseReadinessService } from './database-readiness.service.js';

@Controller()
export class AppController {
  constructor(private readonly databaseReadiness: DatabaseReadinessService) {}

  @Get()
  getDescriptor() {
    return {
      service: 'uconext-api',
      version: 'v1',
    };
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
}
