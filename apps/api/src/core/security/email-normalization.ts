/** Canonical global account email: trimmed and lower-cased, never empty. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Email cannot be empty');
  }
  return normalized;
}
