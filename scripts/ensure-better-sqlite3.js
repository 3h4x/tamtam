/* eslint-env node */

const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const STAMP_PREFIX = 'better-sqlite3-';
const PROBE_SCRIPT = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.prepare('select 1 as ok').get();
db.close();
`;

function readPackageVersion() {
  return require('better-sqlite3/package.json').version;
}

function readState(cwd = process.cwd()) {
  const version = readPackageVersion();
  const abi = process.versions.modules || 'unknown';
  const stampDir = join(cwd, 'node_modules', '.cache', 'tamtam');
  const stampPath = join(stampDir, `${STAMP_PREFIX}${version}-abi-${abi}.stamp`);
  return { abi, cwd, stampDir, stampPath, version };
}

function probeBetterSqlite3(cwd = process.cwd(), spawn = spawnSync) {
  const result = spawn(process.execPath, ['-e', PROBE_SCRIPT], {
    cwd,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status === 0) return null;

  const detail = result.signal
    ? `signal ${result.signal}`
    : `exit code ${result.status ?? 'unknown'}`;
  const extra = [result.stderr, result.stdout]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return new Error(`better-sqlite3 probe failed with ${detail}${extra ? `: ${extra}` : ''}`);
}

function pruneStaleStamps(state) {
  if (!existsSync(state.stampDir)) return;
  for (const entry of readdirSync(state.stampDir)) {
    if (!entry.startsWith(STAMP_PREFIX)) continue;
    if (join(state.stampDir, entry) === state.stampPath) continue;
    rmSync(join(state.stampDir, entry), { force: true });
  }
}

function writeStamp(state) {
  mkdirSync(state.stampDir, { recursive: true });
  pruneStaleStamps(state);
  writeFileSync(
    state.stampPath,
    JSON.stringify({
      abi: state.abi,
      checkedAt: new Date().toISOString(),
      version: state.version,
    }) + '\n'
  );
}

function rebuildBetterSqlite3(state, spawn = spawnSync) {
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawn(pnpmBin, ['rebuild', 'better-sqlite3'], {
    cwd: state.cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`pnpm rebuild better-sqlite3 failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function ensureBetterSqlite3ForCurrentNode(options = {}) {
  const state = readState(options.cwd);
  const spawn = options.spawn || spawnSync;
  const stampExists = options.stampExists || existsSync;
  const probe = options.probe || (() => probeBetterSqlite3(state.cwd, spawn));
  const write = options.writeStamp || writeStamp;
  const currentStampExists = stampExists(state.stampPath);
  const probeError = probe();

  if (currentStampExists && !probeError) {
    return { rebuilt: false, stampPath: state.stampPath };
  }

  rebuildBetterSqlite3(state, spawn);

  const postRebuildError = probe();
  if (postRebuildError) throw postRebuildError;

  write(state);
  return { rebuilt: true, stampPath: state.stampPath };
}

if (require.main === module) {
  try {
    ensureBetterSqlite3ForCurrentNode();
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`[test-preflight] ${message}\n`);
    process.exit(1);
  }
}

module.exports = {
  ensureBetterSqlite3ForCurrentNode,
  probeBetterSqlite3,
  readState,
  rebuildBetterSqlite3,
  writeStamp,
};
