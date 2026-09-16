import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureApi } from './configure-api.js';
import { createJsonLogger, PinoNestLogger } from './core/observability/logger.js';

const bootstrap = async (): Promise<void> => {
  const logger = createJsonLogger({ component: 'api' });
  const app = configureApi(await NestFactory.create(AppModule, { logger: new PinoNestLogger(logger) }), {
    logger,
  });
  await app.listen(process.env.PORT ?? 3000);
};

void bootstrap();
