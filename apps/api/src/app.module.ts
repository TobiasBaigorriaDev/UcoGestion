import 'reflect-metadata';

import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { MetricsService } from './core/observability/metrics.service.js';
import { DatabaseReadinessService } from './database-readiness.service.js';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [AppController],
  providers: [DatabaseReadinessService, MetricsService],
})
export class AppModule {}
