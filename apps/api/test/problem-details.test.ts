import { describe, expect, it } from 'vitest';

import {
  createProblemDetails,
  problemDetailsContentType,
  serializeProblemDetails,
} from '../src/problem-details.js';

describe('Problem Details contract', () => {
  it('serializes the application/problem+json fields with traceability and field errors', () => {
    expect(
      createProblemDetails({
        code: 'VALIDATION_FAILED',
        detail: 'Revisá los campos marcados.',
        fieldErrors: { price: 'Debe tener hasta dos decimales.' },
        instance: '/api/v1/catalog/items',
        status: 422,
        title: 'Datos inválidos',
        traceId: 'trace-123',
        type: 'about:blank',
      }),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      detail: 'Revisá los campos marcados.',
      fieldErrors: { price: 'Debe tener hasta dos decimales.' },
      instance: '/api/v1/catalog/items',
      status: 422,
      title: 'Datos inválidos',
      traceId: 'trace-123',
      type: 'about:blank',
    });
  });

  it('omits optional field errors without leaking implementation details', () => {
    const problem = createProblemDetails({
      code: 'NOT_FOUND',
      detail: 'El recurso solicitado no existe.',
      instance: '/api/v1/items/missing',
      status: 404,
      title: 'Recurso no encontrado',
      traceId: 'trace-456',
      type: 'about:blank',
    });

    expect(problem).not.toHaveProperty('fieldErrors');
    expect(problem).not.toHaveProperty('stack');
  });

  it('serializes a JSON representation for the Problem Details media type', () => {
    const problem = createProblemDetails({
      code: 'CONFLICT',
      detail: 'La versión ya no está vigente.',
      instance: '/api/v1/items/1',
      status: 409,
      title: 'Conflicto',
      traceId: 'trace-789',
      type: 'about:blank',
    });

    expect(problemDetailsContentType).toBe('application/problem+json');
    expect(JSON.parse(serializeProblemDetails(problem))).toEqual(problem);
  });
});
