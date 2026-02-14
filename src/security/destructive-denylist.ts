/**
 * Single source of truth for destructive command signatures. Used to block
 * high-impact operations by default (see CWE-78, OWASP Command Injection).
 * Signature-based; may need updates for new shells or environments.
 */

/** Patterns that identify destructive commands. All are tested case-insensitively. */
export const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-rf\b/,       // recursive force remove
  /\bdd\s+if=/,        // raw device write
  /\bmkfs\b/,          // filesystem format
  />\s*\/dev\//        // redirect to device
];

/**
 * Returns true if the command string matches any destructive pattern.
 * Normalizes by trimming and lowercasing before matching.
 */
export function isDestructiveCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(normalized));
}
