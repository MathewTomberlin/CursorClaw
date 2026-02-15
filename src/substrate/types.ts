/**
 * Substrate: workspace markdown files that define identity, soul, birth, capabilities, user, and tools.
 * Used by the runtime to build the system prompt (Identity, Soul, optional User, BIRTH, optional Capabilities/TOOLS).
 */

/** Content keyed by substrate file name (identity, soul, birth, etc.). Missing files → undefined. */
export interface SubstrateContent {
  identity?: string;
  soul?: string;
  birth?: string;
  capabilities?: string;
  user?: string;
  tools?: string;
}

/** Workspace-relative paths for each substrate file. Defaults are root filenames. */
export interface SubstratePaths {
  identityPath?: string;
  soulPath?: string;
  birthPath?: string;
  capabilitiesPath?: string;
  userPath?: string;
  toolsPath?: string;
}

/** Default filenames in workspace root (no subdir). */
export const DEFAULT_SUBSTRATE_PATHS: Required<SubstratePaths> = {
  identityPath: "IDENTITY.md",
  soulPath: "SOUL.md",
  birthPath: "BIRTH.md",
  capabilitiesPath: "CAPABILITIES.md",
  userPath: "USER.md",
  toolsPath: "TOOLS.md"
};

/** Allowed keys for substrate content (used by store/RPC validation). */
export const SUBSTRATE_KEYS = [
  "identity",
  "soul",
  "birth",
  "capabilities",
  "user",
  "tools"
] as const;

export type SubstrateKey = (typeof SUBSTRATE_KEYS)[number];

export function isSubstrateKey(key: string): key is SubstrateKey {
  return (SUBSTRATE_KEYS as readonly string[]).includes(key);
}
