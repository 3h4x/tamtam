import { readFileSync } from 'fs';
import { extractAssistantTextFromRawLog } from '../lib/agents/work-summary-extractor.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/peek-summary.mjs <log-path>');
  process.exit(1);
}

const raw = readFileSync(path, 'utf-8');
const text = extractAssistantTextFromRawLog(raw);
const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
console.log(`Total paragraphs: ${paragraphs.length}`);
for (let i = paragraphs.length - 8; i < paragraphs.length; i++) {
  if (i < 0) continue;
  console.log(`\n--- [${i}] (${paragraphs[i].length} chars) ---`);
  console.log(paragraphs[i].slice(0, 200));
}
