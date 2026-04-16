import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  experimental: {
    allowDevelopmentBuild: true,
  },
};

export default nextConfig;
