import type { INestApplication } from '@nestjs/common';

export const apiPrefix = 'api/v1';

export const configureApi = (app: INestApplication): INestApplication => {
  app.setGlobalPrefix(apiPrefix);
  return app;
};
