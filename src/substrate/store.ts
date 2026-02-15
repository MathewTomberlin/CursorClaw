import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { SubstrateConfig } from "../config.js";
import { loadSubstrate } from "./loader.js";
import type { SubstrateContent, SubstratePaths } from "./types.js";
import { DEFAULT_SUBSTRATE_PATHS, isSubstrateKey } from "./types.js";

/** Map substrate key to config path key (e.g. identity -> identityPath). */
const KEY_TO_PATH_KEY: Record<string, keyof SubstratePaths> = {
  identity: "identityPath",
  soul: "soulPath",
  birth: "birthPath",
  capabilities: "capabilitiesPath",
  user: "userPath",
  tools: "toolsPath"
};

/**
 * In-memory substrate content. Runtime reads via get() each turn so updates take effect without restart.
 */
export class SubstrateStore {
  private content: SubstrateContent = {};

  get(): SubstrateContent {
    return { ...this.content };
  }

  set(content: SubstrateContent): void {
    this.content = { ...content };
  }

  async reload(
    workspaceDir: string,
    paths?: Partial<SubstratePaths>
  ): Promise<void> {
    const next = await loadSubstrate(workspaceDir, paths);
    this.content = next;
  }

  /**
   * Write content for one key to the workspace file and update in-memory cache.
   * Validates key and path (must be under workspaceDir; no path traversal).
   */
  async writeKey(
    workspaceDir: string,
    config: SubstrateConfig | undefined,
    key: string,
    content: string
  ): Promise<void> {
    if (!isSubstrateKey(key)) {
      throw new Error(`Invalid substrate key: ${key}`);
    }
    const pathKey = KEY_TO_PATH_KEY[key as keyof typeof KEY_TO_PATH_KEY];
    if (!pathKey) {
      throw new Error(`No path for substrate key: ${key}`);
    }
    const rel =
      (config as Record<string, string> | undefined)?.[pathKey] ??
      DEFAULT_SUBSTRATE_PATHS[pathKey];
    const resolved = resolve(workspaceDir, rel);
    const workspaceResolved = resolve(workspaceDir);
    const normalized = resolve(resolved);
    if (!normalized.startsWith(workspaceResolved)) {
      throw new Error("Path must be under workspace root");
    }
    await writeFile(resolved, content, "utf8");
    (this.content as Record<string, string>)[key] = content.trim();
  }
}
