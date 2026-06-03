const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;

function compact(s, max = 280) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function compactBlock(paragraphs, max = 800) {
  const out = [];
  let total = 0;
  for (const p of paragraphs) {
    const cleaned = p.replace(/[ \t]+/g, ' ').trim();
    if (!cleaned) continue;
    const sep = out.length > 0 ? 2 : 0;
    if (total + sep + cleaned.length > max) {
      const remaining = max - total - sep;
      if (remaining > 40) out.push(`${cleaned.slice(0, remaining - 1).trimEnd()}…`);
      break;
    }
    out.push(cleaned);
    total += sep + cleaned.length;
  }
  return out.join('\n\n');
}

function reportField(text, label) {
  const re = new RegExp(`^\\s*[-*]?\\s*${label}:\\s*(.+)$`, 'im');
  return text.match(re)?.[1]?.trim() ?? null;
}

function isImproveQueueRotatedSentinel(text) {
  return /^IMPROVE_QUEUE_ROTATED(?:\s+\d+)?$/m.test(text.trim());
}

function isParagraphBoundary(prevTail, nextHead) {
  if (!prevTail || !nextHead) return false;
  if (/\s$/.test(prevTail)) return false;
  if (!/[.!?:]"?$/.test(prevTail)) return false;
  if (/^\s/.test(nextHead)) return false;
  return /^["“'']?[A-Z]/.test(nextHead);
}

function narrationRegex() {
  const APOS = `['’]`;
  return new RegExp(
    `(`
    + `\\b(?:Let me\\b`
    + `|I${APOS}ll\\b`
    + `|I${APOS}m (going|doing|about|switching|now|checking|reading|running|polling|looking|grabbing|isolating|rerunning|verifying|exploring|reviewing|implementing|writing|adding|finishing|wrapping|making|updating|fixing|testing|inspecting)`
    + `|I need to\\b|I have to\\b|I want to\\b`
    + `|Now I${APOS}ll\\b|Now let me\\b`
    + `|First,? I${APOS}ll\\b|Next,? I${APOS}ll\\b`
    + `|Let${APOS}s\\b)`
    + `|^(Reviewing|Reading|Checking|Running|Looking|Inspecting)\\b`
    + `)`,
    'im',
  );
}

function pushText(out, state, text) {
  if (!text) return;
  if (isParagraphBoundary(state.lastTextTail, text.slice(0, 4))) {
    out.push('\n\n');
  }
  out.push(text);
  state.lastTextTail = text.slice(-4);
}

export function extractAssistantTextFromRawLog(rawLog) {
  const out = [];
  const state = {
    hasEmitted: false,
    isCompacting: false,
    inToolUse: false,
    lastTextTail: '',
  };

  for (const line of rawLog.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(TS_PREFIX_RE);
    if (m) trimmed = trimmed.slice(m[0].length);
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;

    if (parsed.type === 'system' && parsed.subtype === 'status') {
      if (parsed.status === 'compacting') {
        state.isCompacting = true;
      } else if (state.isCompacting) {
        state.isCompacting = false;
      }
    }

    if (parsed.type !== 'stream_event') continue;
    const evt = parsed.event;
    if (!evt || typeof evt !== 'object') continue;

    if (
      evt.type === 'content_block_start' &&
      evt.content_block?.type === 'tool_use'
    ) {
      state.inToolUse = true;
      state.lastTextTail = '';
    }

    if (evt.type === 'content_block_stop' && state.inToolUse) {
      state.inToolUse = false;
    }

    if (
      evt.type === 'content_block_start' &&
      evt.content_block?.type === 'text' &&
      state.hasEmitted
    ) {
      out.push('\n');
      state.lastTextTail = '\n';
    }

    if (
      evt.type === 'content_block_delta' &&
      evt.delta?.type === 'text_delta' &&
      !state.isCompacting
    ) {
      pushText(out, state, evt.delta.text ?? '');
      state.hasEmitted = true;
    }
  }

  return out.join('').trim();
}

export function extractWorkSummary(text) {
  const reportIdx = text.toLowerCase().lastIndexOf('tamtam run report');
  const report = reportIdx >= 0 ? text.slice(reportIdx) : text;
  const summary = reportField(report, 'Summary');
  const actionableRaw = reportField(report, 'Actionable work');
  let actionable = actionableRaw
    ? /^yes\b/i.test(actionableRaw) ? true : /^no\b/i.test(actionableRaw) ? false : null
    : null;
  // Some agents signal "nothing to do" with a documented sentinel instead of an
  // "Actionable work: no" report line. The improve agent's `IMPROVE_QUEUE_ROTATED`
  // is the final line of a clean walk where every candidate was already clean —
  // by definition a no-actionable-work run. Treat it as idle so the recommendation
  // layer routes it to "slow the cadence" rather than the wrong "improve the
  // prompt" lever. Only fill an otherwise-unknown signal — never override an
  // explicit report field.
  if (actionable === null && isImproveQueueRotatedSentinel(text)) {
    actionable = false;
  }
  if (summary) return { summary: compact(summary), actionable };

  if (actionable === false && isImproveQueueRotatedSentinel(text)) {
    return { summary: 'IMPROVE_QUEUE_ROTATED: queue empty; no actionable work.', actionable };
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !isImproveQueueRotatedSentinel(p))
    .filter((p) => !/tamtam run report/i.test(p));
  if (paragraphs.length === 0) return { summary: null, actionable };

  const tail = [paragraphs[paragraphs.length - 1]];
  const narration = narrationRegex();
  for (let i = paragraphs.length - 2; i >= 0 && tail.length < 6; i--) {
    if (narration.test(paragraphs[i])) break;
    tail.unshift(paragraphs[i]);
  }
  return { summary: compactBlock(tail, 800) || null, actionable };
}
