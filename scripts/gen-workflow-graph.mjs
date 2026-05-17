#!/usr/bin/env node
// Render the release-pipeline state-machine diagram to public/workflow-graph.svg.
//
// Source: lib/workflows/pipeline-diagram.ts (the same PIPELINE_DIAGRAM string
// used at runtime). Run automatically as `pnpm prebuild`; safe to invoke
// manually as `pnpm gen:workflow-graph` after editing the diagram.
//
// Skips the render and exits 0 when the generated SVG would be byte-identical
// to the one on disk (lets a no-op build avoid touching the file's mtime).

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outPath = join(repoRoot, 'public', 'workflow-graph.svg');
const diagramModule = pathToFileURL(join(repoRoot, 'lib', 'workflows', 'pipeline-diagram.ts')).href;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadDiagram() {
  // The diagram lives in a `.ts` file but is a plain string export. Read and
  // regex it out so we don't need a TS loader in this script.
  const src = await readFile(new URL(diagramModule), 'utf-8');
  const match = src.match(/export const PIPELINE_DIAGRAM = `([\s\S]+?)`;/);
  if (!match) throw new Error('PIPELINE_DIAGRAM export not found in lib/workflows/pipeline-diagram.ts');
  return match[1];
}

async function findMmdc() {
  const candidates = [
    join(repoRoot, 'node_modules', '.bin', 'mmdc'),
    'mmdc',
  ];
  for (const c of candidates) {
    if (c.includes('/') && existsSync(c)) return c;
    if (!c.includes('/')) return c;
  }
  return 'mmdc';
}

async function findChromeExecutable() {
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) return explicit;

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isBrowserAvailabilityError(error) {
  const msg = String(error?.message || error || '');
  return /Browser was not found|Could not find Chrome|Could not find Chromium|executablePath|spawn .*ENOENT|mmdc .*not found|ENOENT/i.test(msg);
}

async function render(diagram) {
  const tmp = await mkdtemp(join(tmpdir(), 'tamtam-mermaid-'));
  const inPath = join(tmp, 'graph.mmd');
  const tmpOut = join(tmp, 'graph.svg');
  const cfgPath = join(tmp, 'config.json');
  await writeFile(inPath, diagram, 'utf-8');
  await writeFile(cfgPath, JSON.stringify({
    theme: 'dark',
    flowchart: { curve: 'basis', padding: 16 },
    themeVariables: {
      background: 'transparent',
      primaryColor: '#1e293b',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#64748b',
      lineColor: '#94a3b8',
      tertiaryColor: '#0f172a',
    },
  }), 'utf-8');

  // mermaid-cli needs a Chromium-compatible browser. We deliberately don't
  // download one in postinstall (Puppeteer's build script is disabled), so use
  // an explicit/system browser and let main() fall back to the committed SVG
  // when no browser is available.
  const puppeteerCfg = join(tmp, 'puppeteer.json');
  const chromePath = await findChromeExecutable();
  if (!chromePath) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error('No Chrome/Chromium executable found for mermaid-cli');
  }
  await writeFile(puppeteerCfg, JSON.stringify({ executablePath: chromePath }), 'utf-8');

  const mmdc = await findMmdc();
  try {
    await execFileP(mmdc, [
      '--input', inPath,
      '--output', tmpOut,
      '--configFile', cfgPath,
      '--puppeteerConfigFile', puppeteerCfg,
      '--backgroundColor', 'transparent',
      '--quiet',
    ], { cwd: repoRoot });
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    if (e.code === 'ENOENT') {
      throw new Error(
        'mmdc (mermaid-cli) not found. Install with: pnpm add -D @mermaid-js/mermaid-cli\n' +
        'Note: the package pulls puppeteer which downloads a chromium build on install.\n' +
        'If you already have Chrome, set PUPPETEER_SKIP_DOWNLOAD=1 and point\n' +
        'PUPPETEER_EXECUTABLE_PATH at your binary before installing.'
      );
    }
    throw e;
  }
  const svg = await readFile(tmpOut, 'utf-8');
  await rm(tmp, { recursive: true, force: true });
  return svg;
}

async function main() {
  const diagram = await loadDiagram();
  const hasExistingSvg = await fileExists(outPath);
  let fresh;
  try {
    fresh = await render(diagram);
  } catch (e) {
    if (hasExistingSvg && isBrowserAvailabilityError(e)) {
      process.stdout.write('[gen-workflow-graph] skipping render; using committed SVG because Chrome/Chromium is unavailable\n');
      return;
    }
    throw e;
  }
  await mkdir(dirname(outPath), { recursive: true });
  let existing = null;
  try { existing = await readFile(outPath, 'utf-8'); } catch { /* not present */ }
  if (existing === fresh) {
    process.stdout.write('[gen-workflow-graph] up to date\n');
    return;
  }
  await writeFile(outPath, fresh, 'utf-8');
  process.stdout.write(`[gen-workflow-graph] wrote ${outPath} (${fresh.length} bytes)\n`);
}

main().catch((e) => {
  process.stderr.write(`[gen-workflow-graph] ${e.message || e}\n`);
  process.exit(1);
});
