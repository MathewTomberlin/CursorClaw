/**
 * Parser for skill.md content.
 * Minimal schema: Description, Install, Credentials, Usage (## sections).
 */

import type { SkillDefinition } from "./types.js";

function extractSection(content: string, sectionName: string): string {
  const sections = content.split(/\n(?=##\s+)/);
  for (const block of sections) {
    const firstLine = block.indexOf("\n");
    const title = firstLine >= 0 ? block.slice(0, firstLine) : block;
    const name = title.replace(/^##\s+/, "").trim();
    if (name.toLowerCase() === sectionName.toLowerCase()) {
      const body = firstLine >= 0 ? block.slice(firstLine + 1) : "";
      return body.trim();
    }
  }
  return "";
}

/**
 * Parse markdown content into a SkillDefinition.
 * Sections are identified by ## Description, ## Install, ## Credentials, ## Usage.
 */
export function parseSkillMd(content: string): SkillDefinition {
  const description = extractSection(content, "Description");
  const install = extractSection(content, "Install");
  const credentials = extractSection(content, "Credentials");
  const usage = extractSection(content, "Usage");
  return {
    description,
    install,
    credentials,
    usage
  };
}
