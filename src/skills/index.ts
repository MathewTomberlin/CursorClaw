/**
 * Agent Skills: skill definitions, safety, store, install runner.
 * See docs/AGENT_PROFILES_SKILLS_PROVIDER_IMPLEMENTATION.md § 4.
 */

export { analyzeSkillSafety } from "./safety.js";
export type { SafetyResult } from "./safety.js";
export { parseSkillMd, parseCredentialNames } from "./parser.js";
export {
  ensureSkillsDirs,
  readInstalledManifest,
  writeInstalledManifest,
  skillsDirs
} from "./store.js";
export { runInstall } from "./runner.js";
export type { RunInstallResult } from "./runner.js";
export {
  getCredential,
  setCredential,
  deleteCredential,
  listCredentialNames
} from "./credentials.js";
export type { SkillDefinition, InstalledSkillRecord, SkillsManifest } from "./types.js";
