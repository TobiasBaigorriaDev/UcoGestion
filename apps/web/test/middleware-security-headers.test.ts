import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { middleware } from '../middleware.js';

describe('Web security headers and CSP middleware', () => {
  const previousPublicWebOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WEB_ORIGIN = 'https://app.example.test';
  });

  afterEach(() => {
    if (previousPublicWebOrigin === undefined) {
      delete process.env.NEXT_PUBLIC_WEB_ORIGIN;
    } else {
      process.env.NEXT_PUBLIC_WEB_ORIGIN = previousPublicWebOrigin;
    }
  });

  it('generates nonce and attaches strict CSP and defensive security headers', () => {
    const request = new NextRequest('https://app.example.test/');
    const response = middleware(request);

    // 1. CSP with nonce
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBeDefined();
    expect(csp).toContain("'nonce-");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // 2. Request header forwarding nonce to Server Components
    const requestNonce = response.headers.get('x-nonce');
    expect(requestNonce).toBeDefined();
    expect(csp).toContain(`'nonce-${requestNonce}'`);

    // 3. Defensive security headers
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');

    // 4. HSTS for HTTPS requirement
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
    expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains');
  });

  it('redirects HTTP requests to HTTPS when x-forwarded-proto is http', () => {
    const request = new NextRequest('http://localhost:3000/some-path', {
      headers: {
        'x-forwarded-proto': 'http',
        host: 'app.uconext.com',
      },
    });

    const response = middleware(request);
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://app.example.test/some-path');
  });

  it('prevents open redirect via hostile Host header when redirecting to HTTPS', () => {
    const request = new NextRequest('http://localhost:3000/some-path', {
      headers: {
        'x-forwarded-proto': 'http',
        host: 'evil-attacker.com',
      },
    });

    const response = middleware(request);
    expect(response.status).toBe(308);
    const location = response.headers.get('location');
    // Must NOT redirect to the hostile Host domain
    expect(location).not.toContain('evil-attacker.com');
    expect(location).toBe('https://app.example.test/some-path');
  });

  it('does not allow a forged forwarded protocol to bypass an HTTP redirect', () => {
    const request = new NextRequest('http://localhost:3000/some-path', {
      headers: {
        'x-forwarded-proto': 'https',
        host: 'evil-attacker.com',
      },
    });

    const response = middleware(request);
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://app.example.test/some-path');
  });
});
