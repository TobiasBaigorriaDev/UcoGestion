import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_METADATA = 'auth:isPublic';

export const PublicRoute = (): ClassDecorator & MethodDecorator =>
  SetMetadata(PUBLIC_ROUTE_METADATA, true);
