import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureApi } from './configure-api.js';
import { createJsonLogger, PinoNestLogger } from './core/observability/logger.js';
import { startOtlpTracing } from './core/observability/tracing.js';

const bootstrap = async (): Promise<void> => {
  const stopTracing = startOtlpTracing();
  process.once('SIGTERM', () => void stopTracing());
  process.once('SIGINT', () => void stopTracing());
  const logger = createJsonLogger({ component: 'api' });
  const app = configureApi(await NestFactory.create(AppModule, { logger: new PinoNestLogger(logger) }), {
    logger,
  });
  await app.listen(process.env.PORT ?? 3000);
};

void bootstrap();
