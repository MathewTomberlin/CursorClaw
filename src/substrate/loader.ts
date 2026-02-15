import { join } from "node:path";

import { safeReadUtf8 } from "../fs-utils.js";
import type { SubstrateContent, SubstratePaths } from "./types.js";
import { DEFAULT_SUBSTRATE_PATHS } from "./types.js";

/**
 * Load substrate markdown files from the workspace. Missing files yield undefined for that key.
 * Tolerates ENOENT and bad encoding (safe UTF-8 read); does not throw.
 */
export async function loadSubstrate(
  workspaceDir: string,
  paths?: Partial<SubstratePaths>
): Promise<SubstrateContent> {
  const p = { ...DEFAULT_SUBSTRATE_PATHS, ...paths };
  const out: SubstrateContent = {};

  const entries: Array<{ key: keyof SubstrateContent; path: string }> = [
    { key: "agents", path: p.agentsPath },
    { key: "identity", path: p.identityPath },
    { key: "soul", path: p.soulPath },
    { key: "birth", path: p.birthPath },
    { key: "capabilities", path: p.capabilitiesPath },
    { key: "user", path: p.userPath },
    { key: "tools", path: p.toolsPath },
    { key: "roadmap", path: p.roadmapPath }
  ];

  for (const { key, path } of entries) {
    const fullPath = join(workspaceDir, path);
    const raw = await safeReadUtf8(fullPath);
    if (raw) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        (out as Record<string, string>)[key] = trimmed;
      }
    }
  }

  return out;
}
