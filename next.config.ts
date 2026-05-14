import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['pg', 'graphile-worker'],
};

export default withWorkflow(nextConfig);
