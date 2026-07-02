const os = require('os');

const port = process.env.PORT || '1337';
const host = process.env.HOST || '127.0.0.1';

// PM2 launches the app with a curated env, so shell vars like HOME/USER are
// NOT inherited unless set here. A missing HOME is silently corrosive: git and
// gh both resolve their config from ~ (HOME) — global `.gitignore`
// (core.excludesFile), user identity, and `gh` auth/hosts. Without it, git
// runs with no global excludesfile, so globally-ignored files (editor junk,
// .playwright-mcp/ snapshots, .DS_Store) surface as untracked and trip the
// PR-branch execution gate ("uncommitted or untracked changes") on a tree the
// operator's own `git status` reports clean. Pin HOME/USER explicitly.
const home = process.env.HOME || os.homedir();

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
        HOME: home,
        USER: process.env.USER || process.env.LOGNAME || (os.userInfo().username),
        WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD || 'local',
        WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR || 'data/workflow-data',
      },
    },
  ],
};
