/**
 * Per-model maxContextTokens: best-effort token estimation and message trimming.
 * Used by runtime when a model config sets maxContextTokens (TU.2).
 * TU.4: optional summarization of old turns before trimming.
 */

const SUMMARY_PREFIX = "Summary of earlier turns:\n";

/** Best-effort token estimate (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SummarizePrefixResult {
  summaryMessage: { role: string; content: string };
  remainingMessages: Array<{ role: string; content: string }>;
}

/**
 * Replaces a contiguous prefix of messages (all but the last) with a single system summary message.
 * Rule-based: concatenates "User: … Assistant: …" per turn, then truncates to maxSummaryTokens.
 * Use when over cap and summarizeOldTurns is enabled (TU.4).
 */
export function summarizePrefix(
  messages: Array<{ role: string; content: string }>,
  maxSummaryTokens: number
): SummarizePrefixResult {
  if (messages.length <= 1) {
    return {
      summaryMessage: { role: "system", content: SUMMARY_PREFIX + "(none)" },
      remainingMessages: messages.length === 1 ? [messages[0]!] : []
    };
  }
  const prefix = messages.slice(0, -1);
  const lastMessage = messages[messages.length - 1]!;
  const parts: string[] = [];
  for (const m of prefix) {
    const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    parts.push(`${label}: ${m.content}`);
  }
  let text = parts.join("\n\n");
  const maxChars = Math.max(0, maxSummaryTokens * 4);
  if (estimateTokens(text) > maxSummaryTokens && text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  const summaryMessage: { role: string; content: string } = {
    role: "system",
    content: SUMMARY_PREFIX + text
  };
  return { summaryMessage, remainingMessages: [lastMessage] };
}

/**
 * Trims messages so estimated token count ≤ maxContextTokens.
 * Always keeps the last message even if it alone exceeds the cap (per TU.2 guardrail).
 * When truncationPriority is omitted, trims from the start (oldest-first). When set, drops
 * lowest-priority roles first (e.g. ['assistant','user','system'] = drop assistant then user then system).
 */
export function applyMaxContextTokens(
  messages: Array<{ role: string; content: string }>,
  maxContextTokens: number,
  truncationPriority?: ("system" | "user" | "assistant")[]
): Array<{ role: string; content: string }> {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= maxContextTokens) return messages;
  if (!truncationPriority || truncationPriority.length === 0) {
    return applyMaxContextTokensOldestFirst(messages, maxContextTokens);
  }
  return applyMaxContextTokensWithPriority(messages, maxContextTokens, truncationPriority);
}

/** Oldest-first trim (TU.2 default). */
function applyMaxContextTokensOldestFirst(
  messages: Array<{ role: string; content: string }>,
  maxContextTokens: number
): Array<{ role: string; content: string }> {
  let start = 0;
  while (start < messages.length - 1) {
    const slice = messages.slice(start);
    const est = slice.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (est <= maxContextTokens) return slice;
    start += 1;
  }
  return messages.slice(start);
}

/** Priority-aware trim: drop roles in truncationPriority order (first in array = drop first), then oldest within tier. */
function applyMaxContextTokensWithPriority(
  messages: Array<{ role: string; content: string }>,
  maxContextTokens: number,
  truncationPriority: ("system" | "user" | "assistant")[]
): Array<{ role: string; content: string }> {
  const lastIdx = messages.length - 1;
  const tokens = messages.map((m) => estimateTokens(m.content));
  const dropRank = (role: string): number => {
    const i = truncationPriority.indexOf(role as "system" | "user" | "assistant");
    return i === -1 ? truncationPriority.length : i;
  };
  type Entry = { idx: number; tok: number; rank: number };
  const entries: Entry[] = [];
  for (let i = 0; i < lastIdx; i++) {
    entries.push({ idx: i, tok: tokens[i]!, rank: dropRank(messages[i]!.role) });
  }
  // Process in "keep first" order: higher rank = dropped later = we add first.
  entries.sort((a, b) => b.rank - a.rank || b.idx - a.idx);
  const keep = new Set<number>([lastIdx]);
  let totalKeep = tokens[lastIdx]!;
  for (const { idx, tok } of entries) {
    if (totalKeep + tok <= maxContextTokens) {
      keep.add(idx);
      totalKeep += tok;
    }
  }
  return messages.filter((_, i) => keep.has(i));
}
