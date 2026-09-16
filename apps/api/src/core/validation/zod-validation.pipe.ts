import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }

    const fieldErrors = Object.fromEntries(
      parsed.error.issues.map((issue) => [
        issue.path.length === 0 ? 'body' : issue.path.join('.'),
        issue.message,
      ]),
    );
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      detail: 'Los datos enviados no son válidos.',
      fieldErrors,
      title: 'Datos inválidos',
    });
  }
}
