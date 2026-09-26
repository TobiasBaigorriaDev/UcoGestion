export class ConcurrentInventoryModificationError extends Error {
  constructor() { super('Concurrent inventory modification.'); }
}

/** A PostgreSQL deadlock aborts the whole transaction; every attempt starts with a fresh client. */
export async function retryInventoryTransaction<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const code = error instanceof Object && 'code' in error ? error.code : undefined;
      if (code !== '40P01' && code !== '40001') throw error;
      if (attempt === 3) throw new ConcurrentInventoryModificationError();
      await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt + Math.floor(Math.random() * 10)));
    }
  }
  throw new ConcurrentInventoryModificationError();
}
