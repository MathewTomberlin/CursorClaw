import { join } from "node:path";

import { safeReadUtf8 } from "../fs-utils.js";
import { loadSubstrate } from "../substrate/loader.js";
import type { SubstratePaths } from "../substrate/types.js";

/** Max chars to read per file when measuring size (avoids OOM on huge files). */
const MAX_MEASURE_CHARS = 500_000;

export interface MemorySubstrateSizeResult {
  /** Total character count of MEMORY.md (capped at MAX_MEASURE_CHARS if file is larger). */
  memoryChars: number;
  /** Total chars of memory/YYYY-MM-DD.md for today + yesterday. */
  dailyChars: number;
  /** Session injection cap (from config). */
  sessionMemoryCap: number;
  /** True when memoryChars + dailyChars (or injected portion) exceeds cap → truncation / "dumb zone". */
  memoryOverCap: boolean;
  /** Total character count of all loaded substrate files. */
  substrateChars: number;
  /** Optional warn threshold for memory; when exceeded, heartbeat should prompt mitigation. */
  memoryWarnThreshold?: number;
  /** Optional warn threshold for substrate; when exceeded, consider summarizing. */
  substrateWarnThreshold?: number;
  /** True when memory total is at or over memoryWarnThreshold. */
  memoryWarn: boolean;
  /** True when substrate total is at or over substrateWarnThreshold. */
  substrateWarn: boolean;
  /** Whether memory embeddings (vector index) are enabled so recall_memory can find old content. */
  embeddingsEnabled: boolean;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute memory and substrate file sizes for the given profile. Used by the heartbeat
 * checklist so the agent can see when MEMORY.md or substrate is in the "dumb zone" (over
 * injection cap) and run analysis/recovery (integrity scan, vector sync, summarization).
 */
export async function getMemorySubstrateSize(
  profileRoot: string,
  options: {
    sessionMemoryCap: number;
    memoryWarnChars?: number;
    substrateWarnChars?: number;
    embeddingsEnabled?: boolean;
    substratePaths?: Partial<SubstratePaths>;
    today?: string;
  }
): Promise<MemorySubstrateSizeResult> {
  const cap = options.sessionMemoryCap;
  const memoryWarn = options.memoryWarnChars ?? Math.floor(cap * 0.9);
  const substrateWarn = options.substrateWarnChars ?? 60_000;
  const now = options.today ? new Date(options.today) : new Date();
  const today = formatDate(now);
  const yesterday = formatDate(new Date(now.getTime() - 86400 * 1000));

  const memoryPath = join(profileRoot, "MEMORY.md");
  const memoryRaw = await safeReadUtf8(memoryPath, { maxChars: MAX_MEASURE_CHARS });
  const memoryChars = memoryRaw?.length ?? 0;

  let dailyChars = 0;
  for (const label of [today, yesterday]) {
    const dailyPath = join(profileRoot, "memory", `${label}.md`);
    const raw = await safeReadUtf8(dailyPath, { maxChars: MAX_MEASURE_CHARS });
    if (raw) dailyChars += raw.length;
  }

  const totalMemoryChars = memoryChars + dailyChars;
  const memoryOverCap = totalMemoryChars > cap;

  const substrate = await loadSubstrate(profileRoot, options.substratePaths);
  let substrateChars = 0;
  for (const v of Object.values(substrate)) {
    if (typeof v === "string") substrateChars += v.length;
  }

  return {
    memoryChars,
    dailyChars,
    sessionMemoryCap: cap,
    memoryOverCap,
    substrateChars,
    memoryWarnThreshold: memoryWarn,
    substrateWarnThreshold: substrateWarn,
    memoryWarn: totalMemoryChars >= memoryWarn,
    substrateWarn: substrateChars >= substrateWarn,
    embeddingsEnabled: options.embeddingsEnabled === true
  };
}

/**
 * Format a short one-block summary for injection into the heartbeat prompt so the agent
 * sees current sizes and whether to run memory/substrate analysis and recovery.
 */
export function formatMemorySubstrateChecklist(
  result: MemorySubstrateSizeResult,
  options?: { includeRemediation?: boolean }
): string {
  const includeRemediation = options?.includeRemediation !== false;
  const lines: string[] = [
    "## Memory and substrate size (check every heartbeat)",
    "",
    "- **MEMORY.md**: " +
      result.memoryChars.toLocaleString() +
      " chars; daily (today+yesterday): " +
      result.dailyChars.toLocaleString() +
      " chars. Session injection cap: " +
      result.sessionMemoryCap.toLocaleString() +
      " chars.",
    result.memoryOverCap
      ? "- **Over cap:** Injected context is truncated; content beyond the cap is in the \"dumb zone\" (not in your prompt). Use integrity scan and, if embeddings enabled, recall_memory to find important old content; consider summarizing or compacting MEMORY.md."
      : result.memoryWarn
        ? "- **Near cap:** Consider compacting or summarizing soon to avoid truncation."
        : "- Memory size is within cap.",
    "- **Substrate** (AGENTS, IDENTITY, SOUL, USER, etc.): " +
      result.substrateChars.toLocaleString() +
      " chars total." +
      (result.substrateWarn ? " Large; consider keeping only essential parts or summarizing." : ""),
    result.embeddingsEnabled
      ? "- **Vector recall** is enabled; recall_memory can retrieve old content even when MEMORY.md is truncated."
      : "- Vector recall is disabled; only injected MEMORY.md (capped) is in context."
  ];
  if (includeRemediation && (result.memoryWarn || result.memoryOverCap || result.substrateWarn)) {
    lines.push(
      "",
      "**If over or near limits:** (1) Run integrity scan on memory. (2) If embeddings enabled, ensure important facts are still findable via recall_memory. (3) Summarize or compact MEMORY.md (e.g. merge old turn-summary lines, keep notes) and replace file to bring size under cap. (4) If you take action, say so in your reply before HEARTBEAT_OK."
    );
  }
  return lines.join("\n");
}
