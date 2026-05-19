const port = process.env.PORT || '1337';
const host = process.env.HOST || '127.0.0.1';

module.exports = {
  apps: [
    {
      name: 'tamtam',
      script: './node_modules/next/dist/bin/next',
      args: ['start', '--port', port, '--hostname', host],
      interpreter: 'node',
      cwd: __dirname,
      time: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD || 'local',
        WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR || 'data/workflow-data',
      },
    },
  ],
};
