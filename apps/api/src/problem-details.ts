import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import { createRequestCorrelation } from './core/observability/logger.js';

export type FieldErrors = Readonly<Record<string, string>>;

export interface ProblemDetailsInput {
  readonly code: string;
  readonly currentTotal?: string | undefined;
  readonly currentVersion?: number | undefined;
  readonly detail: string;
  readonly fieldErrors?: FieldErrors | undefined;
  readonly instance: string;
  readonly status: number;
  readonly title: string;
  readonly traceId: string;
  readonly type: string;
}

export type ProblemDetails = ProblemDetailsInput;

export const problemDetailsContentType = 'application/problem+json' as const;

export const createProblemDetails = ({
  code,
  currentTotal,
  currentVersion,
  detail,
  fieldErrors,
  instance,
  status,
  title,
  traceId,
  type,
}: ProblemDetailsInput): ProblemDetails => ({
  code,
  ...(currentTotal === undefined ? {} : { currentTotal }),
  ...(currentVersion === undefined ? {} : { currentVersion }),
  detail,
  ...(fieldErrors === undefined ? {} : { fieldErrors }),
  instance,
  status,
  title,
  traceId,
  type,
});

export const serializeProblemDetails = (problem: ProblemDetails): string =>
  JSON.stringify(problem);

export interface ConflictProblemDetailsInput {
  readonly code?: string | undefined;
  readonly currentTotal?: string | undefined;
  readonly currentVersion?: number | undefined;
  readonly detail?: string | undefined;
  readonly instance: string;
  readonly title?: string | undefined;
  readonly traceId: string;
}

export const createConflictProblemDetails = ({
  code = 'VERSION_CONFLICT',
  currentTotal,
  currentVersion,
  detail = 'El recurso fue modificado por otra operación. Actualizá los datos e intentá nuevamente.',
  instance,
  title = 'Conflicto de concurrencia',
  traceId,
}: ConflictProblemDetailsInput): ProblemDetails =>
  createProblemDetails({
    code,
    ...(currentTotal === undefined ? {} : { currentTotal }),
    ...(currentVersion === undefined ? {} : { currentVersion }),
    detail,
    instance,
    status: HttpStatus.CONFLICT,
    title,
    traceId,
    type: 'about:blank',
  });

interface ProblemResponse {
  json(body: unknown): void;
  setHeader(name: string, value: string): ProblemResponse;
  status(code: number): ProblemResponse;
}

@Catch(HttpException)
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<ProblemResponse>();
    const request = ctx.getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      originalUrl?: string;
      url?: string;
    }>();

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const correlation = createRequestCorrelation(request?.headers ?? {});
    const traceId = correlation.trace_id;
    const instance = request?.originalUrl ?? request?.url ?? '/api/v1';

    let code = 'ERROR';
    let title = 'Error';
    let detail = exception.message;
    let fieldErrors: FieldErrors | undefined;
    let currentVersion: number | undefined;
    let currentTotal: string | undefined;

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const resp = exceptionResponse as Record<string, unknown>;
      if (typeof resp.code === 'string') code = resp.code;
      if (typeof resp.title === 'string') title = resp.title;
      if (typeof resp.detail === 'string') detail = resp.detail;
      if (typeof resp.message === 'string' && typeof resp.detail !== 'string') detail = resp.message;
      if (typeof resp.currentVersion === 'number') currentVersion = resp.currentVersion;
      if (typeof resp.currentTotal === 'string') currentTotal = resp.currentTotal;
      if (typeof resp.fieldErrors === 'object' && resp.fieldErrors !== null) {
        fieldErrors = resp.fieldErrors as FieldErrors;
      }
    }

    if (status === HttpStatus.CONFLICT && code === 'ERROR') {
      code = 'VERSION_CONFLICT';
      title = 'Conflicto de concurrencia';
    } else if (status === HttpStatus.PRECONDITION_REQUIRED && code === 'ERROR') {
      code = 'IF_MATCH_REQUIRED';
      title = 'Precondición requerida';
    } else if (status === HttpStatus.BAD_REQUEST && code === 'ERROR') {
      code = 'BAD_REQUEST';
      title = 'Solicitud incorrecta';
    }

    const problem = createProblemDetails({
      code,
      currentTotal,
      currentVersion,
      detail,
      fieldErrors,
      instance,
      status,
      title,
      traceId,
      type: 'about:blank',
    });

    response
      .status(status)
      .setHeader('Content-Type', problemDetailsContentType)
      .json(problem);
  }
}
