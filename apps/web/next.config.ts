import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: ['@uconext/ui'],
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const apiOrigin = process.env.UCONEXT_API_INTERNAL_ORIGIN ?? 'http://localhost:4000';
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
};

export default nextConfig;
