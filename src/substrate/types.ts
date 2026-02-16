/**
 * Substrate: workspace markdown files that define agents (rules), identity, soul, birth, capabilities, user, and tools.
 * Used by the runtime to build the system prompt. AGENTS.md is the coordinating rules file (injected first) so the
 * agent and any client (e.g. Claude Code, Cursor) that uses AGENTS.md as a rules file see consistent behavior.
 */

/** Content keyed by substrate file name (agents, identity, soul, birth, roadmap, etc.). Missing files → undefined. */
export interface SubstrateContent {
  agents?: string;
  identity?: string;
  soul?: string;
  birth?: string;
  capabilities?: string;
  user?: string;
  tools?: string;
  /** Optional planning file: milestones, roadmap, feature backlog. Injected so the agent natively plans and automates work. */
  roadmap?: string;
  /** Optional study goals / topics of interest for long-term multi-cycle work (research → notes → implementation guide → implement). Injected so the agent sees it every turn. */
  studyGoals?: string;
}

/** Workspace-relative paths for each substrate file. Defaults are root filenames. */
export interface SubstratePaths {
  agentsPath?: string;
  identityPath?: string;
  soulPath?: string;
  birthPath?: string;
  capabilitiesPath?: string;
  userPath?: string;
  toolsPath?: string;
  roadmapPath?: string;
  studyGoalsPath?: string;
}

/** Default filenames in workspace root (no subdir). AGENTS.md is the OpenClaw-style rules file (session start, memory, safety). */
export const DEFAULT_SUBSTRATE_PATHS: Required<SubstratePaths> = {
  agentsPath: "AGENTS.md",
  identityPath: "IDENTITY.md",
  soulPath: "SOUL.md",
  birthPath: "BIRTH.md",
  capabilitiesPath: "CAPABILITIES.md",
  userPath: "USER.md",
  toolsPath: "TOOLS.md",
  roadmapPath: "ROADMAP.md",
  studyGoalsPath: "STUDY_GOALS.md"
};

/** Allowed keys for substrate content (used by store/RPC validation). */
export const SUBSTRATE_KEYS = [
  "agents",
  "identity",
  "soul",
  "birth",
  "capabilities",
  "user",
  "tools",
  "roadmap",
  "studyGoals"
] as const;

export type SubstrateKey = (typeof SUBSTRATE_KEYS)[number];

export function isSubstrateKey(key: string): key is SubstrateKey {
  return (SUBSTRATE_KEYS as readonly string[]).includes(key);
}
