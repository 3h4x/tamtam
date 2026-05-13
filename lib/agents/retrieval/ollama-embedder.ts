export async function embedText(
  text: string,
  ollamaUrl: string,
  model: string
): Promise<number[]> {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status}`);
  }
  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings[0];
}
