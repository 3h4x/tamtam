import pg from 'pg';
import { existsSync, readFileSync } from 'fs';
import {
  extractAssistantTextFromRawLog,
  extractWorkSummary,
} from '../lib/agents/work-summary-extractor.mjs';

const { Pool } = pg;

export function resolveDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('[issue-run-summary] DATABASE_URL not set');
  }
  return url;
}

export function openDb() {
  return new Pool({ connectionString: resolveDatabaseUrl(), max: 2 });
}

export function loadSummaryFromLog(logPath) {
  if (!logPath || !existsSync(logPath)) {
    return { summary: null, status: 'missing-log' };
  }
  const raw = readFileSync(logPath, 'utf-8');
  const text = extractAssistantTextFromRawLog(raw);
  const { summary } = extractWorkSummary(text);
  return { summary, status: summary ? 'ok' : 'no-summary' };
}
