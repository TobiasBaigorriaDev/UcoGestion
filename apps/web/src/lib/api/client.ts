import { ApiProblemError, problemFromResponse } from './problem-details';

export { ApiProblemError } from './problem-details';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequestOptions<T> = Readonly<{
  method: HttpMethod;
  organizationId?: string;
  csrfToken?: string;
  idempotencyKey?: string;
  ifMatch?: string;
  requestId?: string;
  body?: unknown;
  signal?: AbortSignal;
  parse?: (value: unknown) => T;
}>;

export class ApiClient {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly basePath = '/api/v1',
  ) {}

  async request<T = void>(path: string, options: ApiRequestOptions<T>): Promise<T | undefined> {
    if (!path.startsWith('/') || path.startsWith('//') || path.split(/[?#]/, 1)[0]?.split('/').includes('..')) {
      throw new Error('La ruta debe estar dentro de /api/v1.');
    }
    const method = options.method;
    if (method === 'GET' && options.body !== undefined) throw new Error('GET no admite body.');

    const headers = new Headers({ Accept: 'application/json, application/problem+json' });
    if (method !== 'GET') headers.set('Content-Type', 'application/json');
    if (options.organizationId) headers.set('X-Organization-Id', options.organizationId);
    if (options.csrfToken) headers.set('X-CSRF-Token', options.csrfToken);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (options.ifMatch) headers.set('If-Match', options.ifMatch);
    if (options.requestId) headers.set('X-Request-Id', options.requestId);

    let response: Response;
    try {
      response = await this.fetcher(`${this.basePath}${path}`, {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiProblemError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: 'No pudimos conectar. Revisá la conexión e intentá nuevamente.',
      });
    }

    if (!response.ok) throw await problemFromResponse(response);
    if (response.status === 204) return undefined;
    if (!options.parse || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new ApiProblemError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'La respuesta no pudo procesarse. Actualizá la página e intentá nuevamente.',
      });
    }
    try {
      return options.parse(await response.json());
    } catch {
      throw new ApiProblemError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'La respuesta no pudo procesarse. Actualizá la página e intentá nuevamente.',
      });
    }
  }
}
