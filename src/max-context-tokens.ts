/**
 * Per-model maxContextTokens: best-effort token estimation and message trimming.
 * Used by runtime when a model config sets maxContextTokens (TU.2).
 */

/** Best-effort token estimate (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trims messages from the start (oldest) so estimated token count ≤ maxContextTokens.
 * Always keeps the last message even if it alone exceeds the cap (per TU.2 guardrail).
 */
export function applyMaxContextTokens(
  messages: Array<{ role: string; content: string }>,
  maxContextTokens: number
): Array<{ role: string; content: string }> {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= maxContextTokens) return messages;
  let start = 0;
  while (start < messages.length - 1) {
    const slice = messages.slice(start);
    const est = slice.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (est <= maxContextTokens) return slice;
    start += 1;
  }
  return messages.slice(start);
}
