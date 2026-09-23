import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: ['@uconext/ui'],
};

export default nextConfig;
