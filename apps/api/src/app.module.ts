import 'reflect-metadata';

import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { DatabaseReadinessService } from './database-readiness.service.js';

@Module({
  controllers: [AppController],
  providers: [DatabaseReadinessService],
})
export class AppModule {}
