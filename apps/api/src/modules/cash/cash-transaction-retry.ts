export class ConcurrentCashModificationError extends Error {
  constructor() { super('Concurrent cash modification.'); }
}

/** PostgreSQL aborts the complete transaction on a deadlock or serialization failure. */
export async function retryCashTransaction<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const code = error instanceof Object && 'code' in error ? error.code : undefined;
      if (code !== '40P01' && code !== '40001') throw error;
      if (attempt === 3) throw new ConcurrentCashModificationError();
      await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt));
    }
  }
  throw new ConcurrentCashModificationError();
}
