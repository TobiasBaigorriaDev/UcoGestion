import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { createSecurityHeaders, generateCspNonce } from '../src/core/security/security-headers.js';

describe('security headers and CSP configuration', () => {
  it('generates high-entropy base64 CSP nonces', () => {
    const nonce1 = generateCspNonce();
    const nonce2 = generateCspNonce();

    expect(nonce1).toBeDefined();
    expect(nonce2).toBeDefined();
    expect(nonce1).not.toBe(nonce2);
    // Base64 16 bytes = 24 chars with padding
    expect(nonce1.length).toBeGreaterThanOrEqual(22);
  });

  it('builds defensive security headers conforming to constitutional requirements', () => {
    const nonce = 'test-nonce-12345';
    const headers = createSecurityHeaders({ nonce });

    // 1. Strict Content-Security-Policy with nonce
    expect(headers['Content-Security-Policy']).toContain(`'nonce-${nonce}'`);
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("base-uri 'self'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");

    // 2. Defensive headers
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');

    // 3. Strict-Transport-Security (HSTS) for mandatory HTTPS
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
    expect(headers['Strict-Transport-Security']).toContain('includeSubDomains');
  });

  it('builds API defensive security headers', () => {
    const headers = createSecurityHeaders({ isApi: true });

    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });

  it('serves defensive security headers on all HTTP responses in NestJS API', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = configureApi(module.createNestApplication());
    await app.init();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('x-forwarded-proto', 'https');

      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(response.headers['strict-transport-security']).toContain('max-age=');
      expect(response.headers['permissions-policy']).toContain('camera=()');
    } finally {
      await app.close();
    }
  });

  it('enforces HTTPS on API requests by redirecting or rejecting non-HTTPS traffic', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = configureApi(module.createNestApplication(), {
      publicApiOrigin: 'https://api.example.test',
    });
    await app.init();

    try {
      // In production or behind reverse proxy, x-forwarded-proto: http must not return 200 plain text/json without HTTPS
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('x-forwarded-proto', 'http')
        .set('host', 'api.uconext.com');

      expect(response.status).toBe(308);
      expect(response.headers.location).toBe('https://api.example.test/api/v1/health/live');
    } finally {
      await app.close();
    }
  });

  it('prevents open redirect on API HTTPS redirection when hostile Host is sent', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = configureApi(module.createNestApplication(), {
      publicApiOrigin: 'https://api.example.test',
    });
    await app.init();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('x-forwarded-proto', 'http')
        .set('host', 'evil-attacker.com');

      expect(response.status).toBe(308);
      expect(response.headers.location).toBe('https://api.example.test/api/v1/health/live');
    } finally {
      await app.close();
    }
  });

  it('does not trust a forged forwarded protocol from an untrusted connection', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = configureApi(module.createNestApplication(), {
      publicApiOrigin: 'https://api.example.test',
    });
    await app.init();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('x-forwarded-proto', 'https')
        .set('host', 'evil-attacker.com');

      expect(response.status).toBe(308);
      expect(response.headers.location).toBe('https://api.example.test/api/v1/health/live');
    } finally {
      await app.close();
    }
  });

  it('accepts forwarded HTTPS only from a configured proxy address', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = configureApi(module.createNestApplication(), {
      publicApiOrigin: 'https://api.example.test',
      trustedProxyIps: ['127.0.0.1'],
    });
    await app.init();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('x-forwarded-proto', 'https');

      expect(response.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
