import { randomBytes } from 'node:crypto';

export interface SecurityHeadersOptions {
  readonly isApi?: boolean | undefined;
  readonly nonce?: string | undefined;
}

export const generateCspNonce = (): string => {
  return randomBytes(16).toString('base64');
};

export const createCspDirectives = ({
  isApi = false,
  nonce,
}: SecurityHeadersOptions = {}): string => {
  if (isApi) {
    return [
      "default-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; ');
  }

  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "'self'";

  // In development, Next.js / Webpack / Turbopack might use 'unsafe-inline' as fallback for styles
  const styleSrc = nonce
    ? `'self' 'nonce-${nonce}' 'unsafe-inline'`
    : "'self' 'unsafe-inline'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
};

export const createSecurityHeaders = (
  options: SecurityHeadersOptions = {},
): Record<string, string> => {
  const csp = createCspDirectives(options);

  return {
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': options.isApi ? 'cross-origin' : 'same-origin',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
};
