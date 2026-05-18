#!/usr/bin/env node
// Render the release-pipeline state-machine diagram to public/workflow-graph.svg.
//
// Source: lib/workflows/pipeline-spec.ts (the same TRIGGERS + TRANSITIONS
// arrays decideNextPhase runs off). The mermaid string is built from the spec
// here — code is the single source of truth; drift between diagram and
// dispatcher is structurally impossible.
//
// Run automatically as `pnpm prebuild`; safe to invoke manually as
// `pnpm gen:workflow-graph` after editing the spec.
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
import { createRequire } from 'node:module';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outPath = join(repoRoot, 'public', 'workflow-graph.svg');
const specPath = join(repoRoot, 'lib', 'workflows', 'pipeline-spec.ts');

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Load the spec via tsx so we get the actual exported arrays. Avoids fragile
// regex parsing and guarantees the diagram is built from the same data
// decideNextPhase uses at runtime.
async function loadSpec() {
  const require = createRequire(import.meta.url);
  // tsx registers a Node loader that transpiles .ts on import.
  const tsxLoaderPath = require.resolve('tsx/esm/api');
  const { tsImport } = await import(pathToFileURL(tsxLoaderPath).href);
  const mod = await tsImport(pathToFileURL(specPath).href, import.meta.url);
  if (!mod.TRIGGERS || !mod.TRANSITIONS) {
    throw new Error('TRIGGERS / TRANSITIONS not exported from pipeline-spec.ts');
  }
  return { TRIGGERS: mod.TRIGGERS, TRANSITIONS: mod.TRANSITIONS };
}

// Convert a TRIGGERS + TRANSITIONS pair into a mermaid `flowchart LR` source.
// Nodes get class assignments matching the existing color palette.
function buildMermaid({ TRIGGERS, TRANSITIONS }) {
  const lines = ['flowchart LR'];
  const triggerIds = new Map(TRIGGERS.map((t) => [t.id, mermaidId(t.id)]));
  const agentRunId = triggerIds.get('agent-run') ?? mermaidId('agent-run');
  const manualId = triggerIds.get('manual') ?? mermaidId('manual');
  const scheduledId = triggerIds.get('scheduled') ?? mermaidId('scheduled');

  // Trigger nodes
  for (const t of TRIGGERS) {
    lines.push(`  ${mermaidId(t.id)}([${t.label}])`);
  }
  // Release-after-run gate (the trigger files own its real logic; we render
  // it here so the diagram shows the entry path the user sees).
  lines.push('');
  lines.push(`  ${agentRunId} --> raR{successful run/agent<br/>+ release_after_run?}`);
  lines.push(`  ${scheduledId} --> ${agentRunId}`);
  lines.push('  raR -->|"yes<br/>issue work ok"| release');
  lines.push('  raR -->|retryable blocker| pending([pending release<br/>drain later])');
  lines.push('  raR -->|no / non-retryable| noRelease([no release])');
  lines.push(`  ${manualId} --> release([release start])`);
  lines.push('');

  // Phase nodes — declared inline by the edges below; only the entry edge
  // from release needs an explicit declaration.
  lines.push('  release --> test[test]');

  // Transition edges, grouped by `from`
  const byFrom = new Map();
  for (const t of TRANSITIONS) {
    if (!byFrom.has(t.from)) byFrom.set(t.from, []);
    byFrom.get(t.from).push(t);
  }
  const phaseOrder = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak', 'fix-ci'];
  for (const from of phaseOrder) {
    const rows = byFrom.get(from);
    if (!rows) continue;
    lines.push('');
    for (const t of rows) {
      const guardMark = t.guardable && t.guardable.length ? ' ⚠ guards' : '';
      const label = `${t.label}${guardMark}`;
      // Wrap label in quotes if it contains characters mermaid treats specially.
      const labelOut = /[<>"`(){}|]/.test(label) ? `"${label}"` : label;
      const targetNode = renderNode(t.to);
      const arrow = t.external ? '-.->' : '-->';
      lines.push(`  ${kebabize(from)} ${arrow}|${labelOut}| ${targetNode}`);
    }
  }

  // Class definitions (match the prior styling)
  lines.push('');
  lines.push('  classDef phase fill:#1e293b,stroke:#64748b,color:#e2e8f0');
  lines.push('  classDef terminal fill:#064e3b,stroke:#10b981,color:#a7f3d0');
  lines.push('  classDef abort fill:#7f1d1d,stroke:#ef4444,color:#fecaca');
  lines.push('  classDef fix fill:#78350f,stroke:#f59e0b,color:#fde68a');
  lines.push('  classDef trigger fill:#1e3a8a,stroke:#60a5fa,color:#dbeafe');
  lines.push('  classDef gate fill:#0f172a,stroke:#94a3b8,color:#cbd5e1');
  lines.push('  class test,review,commit,push,mark-dod,pr-wait phase');
  lines.push('  class fix,fix-ci fix');
  lines.push('  class done,pending,noRelease terminal');
  lines.push(`  class ${agentRunId},${manualId},${scheduledId},release trigger`);
  lines.push('  class raR gate');
  lines.push('  class abort abort');

  return lines.join('\n');
}

function mermaidId(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, '_');
}

function kebabize(name) {
  // mermaid IDs can include hyphens, but for readability keep them as-is.
  return name === 'agent-run' ? 'agent_run' : name;
}

function renderNode(name) {
  // Use shape syntax to make terminals/aborts visually distinct.
  if (name === 'done')   return 'done([done<br/>shipped to default])';
  if (name === 'abort')  return 'abort([abort])';
  if (name === 'fix-ci') return 'fix-ci[fix-ci]';
  // Plain phase nodes (rectangular)
  return `${name}[${name}]`;
}

async function findMmdc() {
  const local = join(repoRoot, 'node_modules', '.bin', 'mmdc');
  return existsSync(local) ? local : 'mmdc';
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
  for (const c of candidates) if (existsSync(c)) return c;
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
        'mmdc (mermaid-cli) not found. Install with: pnpm add -D @mermaid-js/mermaid-cli'
      );
    }
    throw e;
  }
  const svg = await readFile(tmpOut, 'utf-8');
  await rm(tmp, { recursive: true, force: true });
  return svg;
}

async function main() {
  const spec = await loadSpec();
  const diagram = buildMermaid(spec);
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
