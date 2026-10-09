import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  generateBuildId: async () => process.env.UCONEXT_BUILD_ID ?? 'local',
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: ['@uconext/ui'],
  async headers() {
    return [{ source: '/sw.js', headers: [
      { key: 'Cache-Control', value: 'no-cache, max-age=0, must-revalidate' },
      { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self'; connect-src 'self'" },
      { key: 'Service-Worker-Allowed', value: '/' },
    ] }];
  },
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const apiOrigin = process.env.UCONEXT_API_INTERNAL_ORIGIN ?? 'http://localhost:4000';
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
};

export default nextConfig;
