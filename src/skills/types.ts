/**
 * Types for Agent Skills (installable skills per profile).
 * See docs/AGENT_PROFILES_SKILLS_PROVIDER_IMPLEMENTATION.md § 4.
 */

/** Parsed skill definition from a skill.md (description, install, credentials, usage). */
export interface SkillDefinition {
  /** What the skill does. */
  description: string;
  /** Optional install section: commands or steps (e.g. curl, bash). No secrets. */
  install: string;
  /** What credentials are needed (e.g. API key name, env var, file path). No actual secrets. */
  credentials: string;
  /** How to invoke the skill (e.g. tool name, MCP server, doc link). */
  usage: string;
  /** Raw markdown for sections we don't parse (e.g. extra sections). */
  raw?: string;
}

/** Record for an installed skill (metadata only; credentials stored separately). */
export interface InstalledSkillRecord {
  /** Unique id for this skill (e.g. slug from URL or user-provided). */
  id: string;
  /** Source URL or path the skill was installed from. */
  sourceUrl: string;
  /** ISO timestamp when installed. */
  installedAt: string;
  /** Names of credentials this skill uses (no values). */
  credentialNames: string[];
}

/** Manifest file under profile skills/installed/. */
export interface SkillsManifest {
  skills: InstalledSkillRecord[];
}
