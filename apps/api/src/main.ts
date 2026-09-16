import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureApi } from './configure-api.js';

const bootstrap = async (): Promise<void> => {
  const app = configureApi(await NestFactory.create(AppModule));
  await app.listen(process.env.PORT ?? 3000);
};

void bootstrap();
