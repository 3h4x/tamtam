import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractAssistantTextFromRawLog, extractWorkSummary } from '../lib/agents/work-summary-extractor.mjs';

export function resolveDbPath() {
  return process.env.TAMTAM_DB_PATH || join(process.cwd(), 'data', 'db', 'tamtam.db');
}

export function openDb() {
  return new Database(resolveDbPath(), { readonly: false });
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
