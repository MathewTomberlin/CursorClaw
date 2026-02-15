/**
 * Safety analysis for skill definitions before install.
 * See docs/AGENT_PROFILES_SKILLS_PROVIDER_IMPLEMENTATION.md § 4.4 Phase S.2.
 *
 * Rules (deny by default for unknown or risky patterns):
 * - No untrusted remote script execution without integrity (e.g. hash/sha256).
 * - No write outside profile/skills (no /etc, /usr, /bin, arbitrary $HOME paths).
 * - No escalation: sudo, chmod +s, setuid, chown to root, etc.
 */

import type { SkillDefinition } from "./types.js";

export interface SafetyResult {
  allowed: boolean;
  reason: string;
}

/** Substring patterns that indicate privilege escalation or unsafe system changes. */
const ESCALATION_PATTERNS = [
  /\bsudo\b/i,
  /\bchmod\s+[0-7]*[4-7][0-7]{2}/, // setuid/setgid bits
  /\bchmod\s+.*\+s/i,
  /\bchown\s+.*\b(root|0)\b/i,
  /\bsetuid\b/i,
  /\bsetgid\b/i,
  /\bdoas\b/i,
  /\bsu\s+-\s*root/i
];

/** Paths that must not be write targets (outside profile skills dir). */
const UNSAFE_WRITE_PATHS = [
  /\/etc\//i,
  /\/usr\/(bin|lib|sbin|local)/i,
  /\/bin\//i,
  /\/sbin\//i,
  /\/root\//i,
  /\$HOME\s*\/\.(?!cursorclaw)/i, // $HOME/.x where .x is not .cursorclaw
  /\~\/(?!\.cursorclaw)/i,        // ~/.x except ~/.cursorclaw
  /\/dev\//i,
  /\/proc\//i,
  /\/sys\//i
];

/**
 * Detect pipe-to-shell without visible integrity check (hash/sha256/sha512/checksum).
 * Allow if the install block or command line references a checksum.
 */
function hasPipeToShellWithoutIntegrity(installBlock: string): { unsafe: boolean; reason?: string } {
  const pipeToShell = /\|\s*(bash|sh|zsh|dash|ksh)\s*($|[#\s])/i;
  if (!pipeToShell.test(installBlock)) {
    return { unsafe: false };
  }
  const hasIntegrity = /\b(sha256|sha512|sha384|checksum|hash|verify|\.asc\b|--integrity)/i.test(installBlock);
  if (hasIntegrity) {
    return { unsafe: false };
  }
  return {
    unsafe: true,
    reason: "Remote script execution (curl/wget ... | bash) without integrity check (hash/checksum). Deny by default."
  };
}

/**
 * Analyze a skill definition and source URL; return allow/deny and reason.
 * Install section is checked for escalation, unsafe writes, and pipe-to-shell without integrity.
 */
export function analyzeSkillSafety(definition: SkillDefinition, sourceUrl: string): SafetyResult {
  const installBlock = (definition.install || "").trim();
  const combined = `${sourceUrl}\n${installBlock}`.toLowerCase();

  for (const pat of ESCALATION_PATTERNS) {
    if (pat.test(installBlock)) {
      return {
        allowed: false,
        reason: "Install commands may escalate privileges (e.g. sudo, chmod +s, chown root). Not allowed."
      };
    }
  }

  for (const pat of UNSAFE_WRITE_PATHS) {
    if (pat.test(installBlock)) {
      return {
        allowed: false,
        reason: "Install commands may write outside profile/skills (e.g. /etc, /usr, /bin). Not allowed."
      };
    }
  }

  const pipeCheck = hasPipeToShellWithoutIntegrity(installBlock);
  if (pipeCheck.unsafe) {
    return {
      allowed: false,
      reason: pipeCheck.reason ?? "Remote script execution without integrity verification. Not allowed."
    };
  }

  if (installBlock.length === 0) {
    return { allowed: true, reason: "No install commands; nothing to run." };
  }

  return { allowed: true, reason: "Safety check passed; install section has no disallowed patterns." };
}
