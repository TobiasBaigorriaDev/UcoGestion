export type FieldErrors = Readonly<Record<string, string>>;

export type ProblemDetails = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  traceId: string;
  fieldErrors?: FieldErrors;
  currentVersion?: number;
  currentTotal?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProblemDetails(value: unknown, status: number): ProblemDetails | null {
  if (!isRecord(value) || value.status !== status) return null;
  for (const key of ['type', 'title', 'code', 'detail', 'instance', 'traceId']) {
    if (typeof value[key] !== 'string') return null;
  }
  if (value.fieldErrors !== undefined
    && (!isRecord(value.fieldErrors)
      || Object.values(value.fieldErrors).some((message) => typeof message !== 'string'))) return null;
  if (value.currentVersion !== undefined && typeof value.currentVersion !== 'number') return null;
  if (value.currentTotal !== undefined && typeof value.currentTotal !== 'string') return null;

  const fieldErrors: Record<string, string> = {};
  if (isRecord(value.fieldErrors)) {
    for (const [field, message] of Object.entries(value.fieldErrors)) {
      if (typeof message === 'string') fieldErrors[field] = message;
    }
  }

  return {
    type: String(value.type),
    title: String(value.title),
    status,
    code: String(value.code),
    detail: String(value.detail),
    instance: String(value.instance),
    traceId: String(value.traceId),
    ...(value.fieldErrors === undefined ? {} : { fieldErrors }),
    ...(value.currentVersion === undefined ? {} : { currentVersion: value.currentVersion }),
    ...(value.currentTotal === undefined ? {} : { currentTotal: value.currentTotal }),
  };
}

export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | undefined;
  readonly fieldErrors: FieldErrors;
  readonly currentVersion: number | undefined;
  readonly currentTotal: string | undefined;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    traceId?: string | undefined;
    fieldErrors?: FieldErrors | undefined;
    currentVersion?: number | undefined;
    currentTotal?: string | undefined;
  }) {
    super(input.message);
    this.name = 'ApiProblemError';
    this.status = input.status;
    this.code = input.code;
    this.traceId = input.traceId;
    this.fieldErrors = input.fieldErrors ?? {};
    this.currentVersion = input.currentVersion;
    this.currentTotal = input.currentTotal;
  }
}

export async function problemFromResponse(response: Response): Promise<ApiProblemError> {
  let problem: ProblemDetails | null = null;
  if (response.headers.get('content-type')?.toLowerCase().includes('application/problem+json')) {
    try {
      problem = parseProblemDetails(await response.json(), response.status);
    } catch {
      problem = null;
    }
  }

  if (response.status >= 500) {
    return new ApiProblemError({
      status: response.status,
      code: 'SERVER_ERROR',
      message: 'El servicio no está disponible. Intentá nuevamente en unos minutos.',
      ...(problem?.traceId ? { traceId: problem.traceId } : {}),
    });
  }
  if (problem) {
    return new ApiProblemError({
      status: response.status,
      code: problem.code,
      message: problem.detail,
      traceId: problem.traceId,
      fieldErrors: problem.fieldErrors,
      currentVersion: problem.currentVersion,
      currentTotal: problem.currentTotal,
    });
  }
  return new ApiProblemError({
    status: response.status,
    code: 'REQUEST_FAILED',
    message: response.status === 401
      ? 'Tu sesión no está disponible. Iniciá sesión nuevamente.'
      : 'No pudimos completar la solicitud. Revisá los datos e intentá nuevamente.',
  });
}
