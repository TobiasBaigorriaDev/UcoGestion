import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export const createOpenApiDocument = (app: INestApplication): OpenAPIObject =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('UcoNext API')
      .setDescription('Contrato HTTP versionado del MVP UcoNext.')
      .setVersion('v1')
      .build(),
  );
