import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'sqlite-vec', 'pg', 'graphile-worker'],
};

export default withWorkflow(nextConfig);
