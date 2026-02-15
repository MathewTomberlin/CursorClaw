import { join } from "node:path";

import { safeReadUtf8 } from "../fs-utils.js";

/** Max total characters for injected session memory (MEMORY.md + daily files). */
const DEFAULT_CAP_CHARS = 32_000;
/** Max characters to read per file so huge files don't OOM; output is still capped by DEFAULT_CAP_CHARS. */
const MAX_READ_PER_FILE = 500_000;

/**
 * Load session-start memory for main session: MEMORY.md plus memory/YYYY-MM-DD.md (today and yesterday).
 * Used to inject into the system prompt so the agent has continuity without relying on "read the file" instructions.
 * Tolerates missing files and bad encoding (safe UTF-8 read). Caps total size to avoid token blow-up.
 */
export async function loadSessionMemoryContext(
  profileRoot: string,
  options?: { capChars?: number; today?: string }
): Promise<string | undefined> {
  const cap = options?.capChars ?? DEFAULT_CAP_CHARS;
  const now = options?.today ? new Date(options.today) : new Date();
  const today = formatDate(now);
  const yesterday = formatDate(new Date(now.getTime() - 86400 * 1000));

  const parts: string[] = [];

  const memoryPath = join(profileRoot, "MEMORY.md");
  const raw = await safeReadUtf8(memoryPath, { maxChars: MAX_READ_PER_FILE });
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      parts.push("Long-term memory (MEMORY.md):\n\n" + trimmed);
    }
  }

  for (const label of [today, yesterday]) {
    if (parts.join("").length >= cap) break;
    const dailyPath = join(profileRoot, "memory", `${label}.md`);
    const dailyRaw = await safeReadUtf8(dailyPath, { maxChars: MAX_READ_PER_FILE });
    if (dailyRaw) {
      const trimmed = dailyRaw.trim();
      if (trimmed.length > 0) {
        parts.push(`Daily memory (${label}):\n\n` + trimmed);
      }
    }
  }

  if (parts.length === 0) return undefined;
  const combined = parts.join("\n\n---\n\n");
  if (combined.length > cap) {
    return combined.slice(0, cap) + "\n\n[... truncated for length]";
  }
  return combined;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
