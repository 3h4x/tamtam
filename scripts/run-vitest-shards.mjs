#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const extraArgs = process.argv.slice(2);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runVitest(args) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--no-color', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    console.error(`vitest terminated with ${result.signal}`);
    process.exit(1);
  }
}

if (extraArgs.length > 0) {
  runVitest(extraArgs);
  process.exit(0);
}

const fastShards = envInt('TAMTAM_VITEST_FAST_SHARDS', 16);
const dbShards = envInt('TAMTAM_VITEST_DB_SHARDS', 8);

for (let shard = 1; shard <= fastShards; shard += 1) {
  runVitest(['--project', 'fast', `--shard=${shard}/${fastShards}`]);
}

runVitest(['--project', 'slow']);

for (let shard = 1; shard <= dbShards; shard += 1) {
  runVitest(['--project', 'db', `--shard=${shard}/${dbShards}`]);
}
