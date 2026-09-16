import { NextResponse, type NextRequest } from 'next/server';

export const generateNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
};

export const createCsp = (nonce: string): string => {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
};

export function middleware(request: NextRequest): NextResponse {
  const publicWebOrigin = resolvePublicWebOrigin();
  if (publicWebOrigin.protocol === 'https:' && request.nextUrl.protocol !== 'https:') {
    const httpsUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, publicWebOrigin);
    return NextResponse.redirect(httpsUrl, 308);
  }

  const nonce = generateNonce();
  const csp = createCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=()',
  );
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  );

  return response;
}

function resolvePublicWebOrigin(): URL {
  const origin = process.env.NEXT_PUBLIC_WEB_ORIGIN;
  if (origin === undefined && process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_WEB_ORIGIN is required in production.');
  }

  const parsed = new URL(origin ?? 'http://localhost:3000');
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('NEXT_PUBLIC_WEB_ORIGIN must be an origin without a path, query, or hash.');
  }
  return parsed;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    {
      missing: [
        { key: 'next-router-prefetch', type: 'header' },
        { key: 'purpose', type: 'header', value: 'prefetch' },
      ],
      source: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    },
  ],
};
