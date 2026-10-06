import { ApiProblemError } from './problem-details';

export function isBusinessOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

/** Ordinary API work is online-only. Offline business effects use the dedicated
 * local POS cases; no administrative request is persisted for later replay. */
export function requireBusinessOnline(online: () => boolean = isBusinessOnline): void {
  if (!online()) throw new ApiProblemError({ status: 0, code: 'OFFLINE_NOT_ALLOWED',
    message: 'Esta acción necesita conexión. Las operaciones pendientes del POS se conservan.' });
}
