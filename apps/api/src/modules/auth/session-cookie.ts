export function readSessionCookie(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const matches = raw.split(';').map((part) => part.trim())
    .filter((part) => part.startsWith('__Host-uco_session='));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice('__Host-uco_session='.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
