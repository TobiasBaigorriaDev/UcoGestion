export type FieldErrors = Readonly<Record<string, string>>;

export interface ProblemDetailsInput {
  readonly code: string;
  readonly detail: string;
  readonly fieldErrors?: FieldErrors;
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
  detail,
  fieldErrors,
  instance,
  status,
  title,
  traceId,
  type,
}: ProblemDetailsInput): ProblemDetails => ({
  code,
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
