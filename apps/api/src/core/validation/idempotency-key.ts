import { HttpException, HttpStatus } from '@nestjs/common';

export function requireIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new HttpException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      title: 'Precondición requerida',
      detail: 'Enviá una clave Idempotency-Key válida.',
    }, HttpStatus.PRECONDITION_REQUIRED);
  }
  return key;
}
