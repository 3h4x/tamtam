#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const { redactSecrets } = require('./log-redaction');

const [, , logPath] = process.argv;

if (!logPath) {
  console.error('[tamtam] redact-log-stream: usage: <logPath>');
  process.exit(2);
}

let logFd;
try {
  logFd = fs.openSync(logPath, 'a');
} catch (err) {
  console.error(`[tamtam] redact-log-stream: cannot open log ${logPath}: ${err.message}`);
  process.exit(2);
}

process.stdin.on('data', (chunk) => {
  try {
    fs.writeSync(logFd, redactSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)));
  } catch {
    // noop
  }
});

process.stdin.on('end', () => {
  try { fs.closeSync(logFd); } catch {}
  process.exit(0);
});

process.stdin.on('error', () => {
  try { fs.closeSync(logFd); } catch {}
  process.exit(1);
});
