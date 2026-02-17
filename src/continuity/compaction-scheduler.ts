import { CronExpressionParser } from "cron-parser";

import type { ContinuityConfig } from "../config.js";
import { runMemoryCompaction } from "./memory-compaction.js";

export interface CompactionSchedulerOptions {
  getConfig: () => ContinuityConfig | undefined;
  getProfileRoots: () => Array<{ profileId: string; workspaceDir: string }>;
  /** Called after a compaction run for a profile (when compaction actually ran). */
  onAfterCompaction?: (profileId: string, workspaceDir: string) => Promise<void>;
  /** Called every scheduler tick for each profile (e.g. experience extraction). */
  onTick?: (profileId: string, workspaceDir: string) => Promise<void>;
}

/**
 * Schedules memory compaction in the background. Does not block the main turn queue
 * or heartbeat. Uses setInterval or cron; when tick fires, runs compaction for each
 * profile (with lock so only one compaction per profile at a time).
 */
export function startCompactionScheduler(options: CompactionSchedulerOptions): { stop: () => void } {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let cronNext: number | null = null;

  const runOnce = async (): Promise<void> => {
    const config = options.getConfig();
    const runCompaction = config?.memoryCompactionEnabled === true;
    const runTick = options.onTick != null;
    if (!runCompaction && !runTick) return;

    const roots = options.getProfileRoots();
    for (const { profileId, workspaceDir } of roots) {
      try {
        const result = runCompaction
          ? await runMemoryCompaction({
              workspaceDir,
              minAgeDays: config.memoryCompactionMinAgeDays ?? 7,
              ...(config.memoryCompactionMaxRecords != null ? { maxRecords: config.memoryCompactionMaxRecords } : {}),
              ...(config.memoryCompactionMaxChars != null ? { maxChars: config.memoryCompactionMaxChars } : {}),
              longMemoryPath: config.longMemoryPath ?? "LONGMEMORY.md",
              longMemoryMaxChars: config.longMemoryMaxChars ?? 16_000,
              ...(config.memoryArchivePath != null ? { archivePath: config.memoryArchivePath } : {}),
              ...(options.onAfterCompaction != null
                ? { onAfterCompaction: () => options.onAfterCompaction!(profileId, workspaceDir) }
                : {})
            })
          : { ran: false, recordsBefore: 0, recordsAfter: 0, recordsCompacted: 0, longMemoryAppended: false };
        if (runCompaction && result.ran && result.recordsCompacted > 0 && process.env.NODE_ENV !== "test") {
          // eslint-disable-next-line no-console
          console.log(
            "[CursorClaw] memory compaction:",
            profileId,
            "records",
            result.recordsBefore,
            "->",
            result.recordsAfter,
            "compacted",
            result.recordsCompacted
          );
        }
        if (options.onTick) {
          await options.onTick(profileId, workspaceDir);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "test") {
          // eslint-disable-next-line no-console
          console.warn("[CursorClaw] memory compaction failed for", profileId, (err as Error).message);
        }
      }
    }
  };

  const scheduleNext = (): void => {
    const config = options.getConfig();
    const runCompaction = config?.memoryCompactionEnabled === true;
    const runTick = options.onTick != null;
    if (!runCompaction && !runTick) return;

    const cronExpr = config?.memoryCompactionScheduleCron;
    if (cronExpr && cronExpr.trim().length > 0) {
      try {
        const interval = CronExpressionParser.parse(cronExpr);
        const next = interval.next().getTime();
        cronNext = next;
        const delay = Math.max(0, next - Date.now());
        setTimeout(() => {
          runOnce().finally(() => scheduleNext());
        }, delay);
      } catch {
        if (intervalId == null) {
          const ms = config?.memoryCompactionIntervalMs ?? 86400_000;
          intervalId = setInterval(() => runOnce(), ms);
        }
      }
      return;
    }

    const ms = config?.memoryCompactionIntervalMs ?? 86400_000;
    if (intervalId == null) {
      intervalId = setInterval(() => runOnce(), ms);
    }
  };

  scheduleNext();

  return {
    stop: () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}
