export const CHUNK_SIZE = 1800;   // ~512 tokens at ~3.5 chars/token
export const CHUNK_OVERLAP = 200;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+[^\n]+$/;
const HEADED_BLOCK_RE = /^(#{1,6}\s+[^\n]+)\n\n([\s\S]+)$/;

function splitIntoBlocks(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const blocks: string[] = [];
  let pendingHeading = '';

  for (const paragraph of paragraphs) {
    if (MARKDOWN_HEADING_RE.test(paragraph)) {
      pendingHeading = pendingHeading ? `${pendingHeading}\n${paragraph}` : paragraph;
      continue;
    }
    blocks.push(pendingHeading ? `${pendingHeading}\n\n${paragraph}` : paragraph);
    pendingHeading = '';
  }

  if (pendingHeading) blocks.push(pendingHeading);
  return blocks;
}

function splitOversizedBlock(block: string): string[] {
  if (block.length <= CHUNK_SIZE) return [block];

  const headingMatch = block.match(HEADED_BLOCK_RE);
  const heading = headingMatch ? `${headingMatch[1]}\n\n` : '';
  const body = headingMatch ? headingMatch[2] : block;
  const maxBodyLength = Math.max(1, CHUNK_SIZE - heading.length);
  const chunks: string[] = [];
  let start = 0;

  while (start < body.length) {
    const end = Math.min(start + maxBodyLength, body.length);
    chunks.push(`${heading}${body.slice(start, end)}`);
    if (end === body.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const block of splitIntoBlocks(text)) {
    if (block.length > CHUNK_SIZE) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitOversizedBlock(block));
      continue;
    }
    if (!current) {
      current = block;
      continue;
    }
    const combined = `${current}\n\n${block}`;
    if (combined.length <= CHUNK_SIZE) {
      current = combined;
      continue;
    }
    chunks.push(current);
    current = block;
  }

  if (current) chunks.push(current);
  return chunks;
}
