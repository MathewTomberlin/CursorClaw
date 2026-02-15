import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SubstrateContent, SubstratePaths } from "./types.js";
import { DEFAULT_SUBSTRATE_PATHS } from "./types.js";

/**
 * Load substrate markdown files from the workspace. Missing files yield undefined for that key.
 * Tolerates ENOENT; does not throw. Uses UTF-8; on decode error skips that file (log and continue).
 */
export async function loadSubstrate(
  workspaceDir: string,
  paths?: Partial<SubstratePaths>
): Promise<SubstrateContent> {
  const p = { ...DEFAULT_SUBSTRATE_PATHS, ...paths };
  const out: SubstrateContent = {};

  const entries: Array<{ key: keyof SubstrateContent; path: string }> = [
    { key: "identity", path: p.identityPath },
    { key: "soul", path: p.soulPath },
    { key: "birth", path: p.birthPath },
    { key: "capabilities", path: p.capabilitiesPath },
    { key: "user", path: p.userPath },
    { key: "tools", path: p.toolsPath }
  ];

  for (const { key, path } of entries) {
    const fullPath = join(workspaceDir, path);
    try {
      const raw = await readFile(fullPath, "utf8");
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        (out as Record<string, string>)[key] = trimmed;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        continue;
      }
      if (code === "EISDIR") {
        continue;
      }
      // Decode/read errors: skip this file, do not crash (guardrail: startup resilience)
      if (typeof (err as Error).message === "string") {
        // eslint-disable-next-line no-console
        console.warn(`[CursorClaw] substrate skip ${path}:`, (err as Error).message);
      }
    }
  }

  return out;
}
