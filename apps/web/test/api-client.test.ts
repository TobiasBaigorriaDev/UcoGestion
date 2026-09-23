import { describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiProblemError } from '../src/lib/api/client.js';

const problem = {
  type: 'about:blank',
  title: 'Solicitud incorrecta',
  status: 400,
  code: 'BAD_REQUEST',
  detail: 'Corregí el nombre e intentá nuevamente.',
  instance: '/api/v1/customers',
  traceId: 'trace-123',
  fieldErrors: { name: 'Ingresá un nombre.' },
};

describe('ApiClient', () => {
  it('sends tenant, CSRF and idempotency context with same-origin JSON requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'customer-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ApiClient(fetcher);
    const result = await client.request('/customers', {
      method: 'POST',
      organizationId: 'org-1',
      csrfToken: 'csrf-1',
      idempotencyKey: 'operation-1',
      body: { name: 'Ana' },
      parse: (value) => {
        if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') {
          throw new Error('Invalid customer response');
        }
        return { id: value.id };
      },
    });

    expect(result).toEqual({ id: 'customer-1' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/customers');
    expect(init?.credentials).toBe('include');
    expect(init?.cache).toBe('no-store');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-organization-id')).toBe('org-1');
    expect(headers.get('x-csrf-token')).toBe('csrf-1');
    expect(headers.get('idempotency-key')).toBe('operation-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ name: 'Ana' }));
  });

  it('uses safe Problem Details and supports empty responses', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(problem), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient(fetcher);

    await expect(client.request('/customers', { method: 'GET' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Corregí el nombre e intentá nuevamente.',
      traceId: 'trace-123',
      fieldErrors: { name: 'Ingresá un nombre.' },
    });
    await expect(client.request('/auth/login', { method: 'POST', body: {} })).resolves.toBeUndefined();
  });

  it('does not expose HTML, server internals or network exception text', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<h1>database password=secret</h1>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }))
      .mockRejectedValueOnce(new Error('https://internal.example/token=secret'));
    const client = new ApiClient(fetcher);

    const first = await client.request('/customers', { method: 'GET' }).catch((error: unknown) => error);
    const second = await client.request('/customers', { method: 'GET' }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ApiProblemError);
    expect(second).toBeInstanceOf(ApiProblemError);
    expect(String(first)).not.toContain('secret');
    expect(String(second)).not.toContain('secret');
  });

  it('hides details from a structured server error and invalid success payloads', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...problem, status: 500, detail: 'sql=secret' }), {
        status: 500,
        headers: { 'content-type': 'application/problem+json' },
      }))
      .mockResolvedValueOnce(new Response('<html>secret</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));
    const client = new ApiClient(fetcher);

    const first = await client.request('/customers', { method: 'GET' }).catch((error: unknown) => error);
    const second = await client.request('/customers', { method: 'GET', parse: (value) => value }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ApiProblemError);
    expect(second).toBeInstanceOf(ApiProblemError);
    expect(String(first)).not.toContain('secret');
    expect(String(second)).not.toContain('secret');
  });

  it('rejects paths outside the API base', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ApiClient(fetcher);
    await expect(client.request('//other.example/path', { method: 'GET' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
