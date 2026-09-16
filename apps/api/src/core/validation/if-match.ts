import {
  BadRequestException,
  ConflictException,
  createParamDecorator,
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

export interface ParseIfMatchOptions {
  readonly required?: boolean | undefined;
}

export class IfMatchRequiredException extends HttpException {
  constructor(detail = 'El encabezado If-Match es requerido para modificar este recurso.') {
    super(
      {
        code: 'IF_MATCH_REQUIRED',
        detail,
        title: 'Precondición requerida',
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}

export class InvalidIfMatchException extends BadRequestException {
  constructor(
    detail = 'El encabezado If-Match debe contener una versión numérica entera válida.',
  ) {
    super({
      code: 'INVALID_IF_MATCH',
      detail,
      title: 'Encabezado inválido',
    });
  }
}

export interface VersionConflictOptions {
  readonly currentTotal?: string | undefined;
  readonly currentVersion: number;
  readonly detail?: string | undefined;
  readonly instance?: string | undefined;
  readonly title?: string | undefined;
}

export class VersionConflictException extends ConflictException {
  readonly currentTotal?: string | undefined;
  readonly currentVersion: number;

  constructor({
    currentTotal,
    currentVersion,
    detail = 'El recurso fue modificado por otra operación. Actualizá los datos e intentá nuevamente.',
    instance,
    title = 'Conflicto de concurrencia',
  }: VersionConflictOptions) {
    super({
      code: 'VERSION_CONFLICT',
      ...(currentTotal === undefined ? {} : { currentTotal }),
      currentVersion,
      detail,
      ...(instance === undefined ? {} : { instance }),
      title,
    });
    this.currentVersion = currentVersion;
    this.currentTotal = currentTotal;
  }
}

const nonNegativeIntegerPattern = /^(?:0|[1-9]\d*)$/;

export const parseIfMatchVersion = (
  header: unknown,
  options: ParseIfMatchOptions = {},
): number | undefined => {
  const isRequired = options.required ?? true;

  if (header === undefined || header === null) {
    if (isRequired) {
      throw new IfMatchRequiredException();
    }
    return undefined;
  }

  const raw = Array.isArray(header) ? header[0] : header;

  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 0) {
      return raw;
    }
    throw new InvalidIfMatchException();
  }

  if (typeof raw !== 'string') {
    throw new InvalidIfMatchException();
  }

  let cleaned = raw.trim();
  if (cleaned.length === 0) {
    throw new InvalidIfMatchException();
  }

  if (cleaned.startsWith('W/') || cleaned.startsWith('w/')) {
    throw new InvalidIfMatchException(
      'El encabezado If-Match requiere comparación fuerte y no admite etiquetas débiles (W/).',
    );
  }

  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!nonNegativeIntegerPattern.test(cleaned)) {
    throw new InvalidIfMatchException();
  }

  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidIfMatchException();
  }

  return parsed;
};

export const assertVersionMatch = (
  expectedVersion: number,
  currentVersion: number,
  context?: {
    currentTotal?: string | undefined;
    detail?: string | undefined;
    instance?: string | undefined;
  },
): void => {
  if (expectedVersion !== currentVersion) {
    throw new VersionConflictException({
      ...(context?.currentTotal !== undefined ? { currentTotal: context.currentTotal } : {}),
      currentVersion,
      ...(context?.detail !== undefined ? { detail: context.detail } : {}),
      ...(context?.instance !== undefined ? { instance: context.instance } : {}),
    });
  }
};

export const IfMatchVersion = createParamDecorator(
  (options: ParseIfMatchOptions | undefined, ctx: ExecutionContext): number | undefined => {
    const request = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = request.headers['if-match'];
    return parseIfMatchVersion(header, options);
  },
);

export interface OptimisticUpdateParams<TResult = unknown> {
  readonly client: {
    query: <TRow = unknown>(sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: TRow[] }>;
  };
  readonly context?: {
    currentTotal?: string | undefined;
    detail?: string | undefined;
    instance?: string | undefined;
  } | undefined;
  readonly expectedVersion: number;
  readonly getCurrentVersion: () => Promise<number | null>;
  readonly update: () => Promise<{ rowCount: number | null; result?: TResult | undefined }>;
}

export const executeOptimisticUpdate = async <TResult = unknown>({
  context,
  expectedVersion,
  getCurrentVersion,
  update,
}: OptimisticUpdateParams<TResult>): Promise<TResult | undefined> => {
  const { result, rowCount } = await update();

  if (rowCount === 0) {
    const currentVersion = await getCurrentVersion();
    if (currentVersion !== null) {
      assertVersionMatch(expectedVersion, currentVersion, context);
    }
  }

  return result;
};
