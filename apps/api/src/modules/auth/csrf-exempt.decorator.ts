import { SetMetadata } from '@nestjs/common';

export const CSRF_EXEMPT_METADATA = 'auth:csrfExempt';

export const CsrfExempt = (): MethodDecorator => SetMetadata(CSRF_EXEMPT_METADATA, true);
