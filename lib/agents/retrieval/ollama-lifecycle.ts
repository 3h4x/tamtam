import { exec as shellExec } from '@/lib/shared/shell';

async function ollamaReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(url: string, maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await ollamaReachable(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureModelPulled(ollamaUrl: string, model: string): Promise<void> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    const pulled = data.models.some((m) => m.name.startsWith(model));
    if (!pulled) {
      console.log(`[retrieval] Pulling ${model}...`);
      await shellExec('ollama', ['pull', model], { timeout: 300_000 });
    }
  } catch (err) {
    console.warn('[retrieval] ensureModelPulled failed:', err);
  }
}

export async function ensureOllamaRunning(opts: {
  ollamaUrl: string;
  embeddingModel: string;
  manageOllama: boolean;
}): Promise<void> {
  if (!opts.manageOllama) return;

  if (await ollamaReachable(opts.ollamaUrl)) {
    await ensureModelPulled(opts.ollamaUrl, opts.embeddingModel);
    return;
  }

  console.log('[retrieval] Ollama not running — starting via PM2');
  const pm2Describe = await shellExec('pm2', ['describe', 'ollama-serve'], { timeout: 5000 });

  if (pm2Describe.exitCode !== 0) {
    await shellExec('pm2', ['start', 'ollama', '--name', 'ollama-serve', '--', 'serve'], { timeout: 10_000 });
  } else {
    await shellExec('pm2', ['restart', 'ollama-serve'], { timeout: 10_000 });
  }

  const up = await waitForOllama(opts.ollamaUrl);
  if (!up) {
    console.warn('[retrieval] Ollama did not start within 5s — retrieval unavailable this session');
    return;
  }

  await ensureModelPulled(opts.ollamaUrl, opts.embeddingModel);
}
