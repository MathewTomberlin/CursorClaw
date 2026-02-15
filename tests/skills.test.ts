import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseSkillMd } from "../src/skills/parser.js";
import {
  readInstalledManifest,
  writeInstalledManifest,
  ensureSkillsDirs,
  skillsDirs
} from "../src/skills/store.js";

describe("skills parser", () => {
  it("parses skill.md with Description, Install, Credentials, Usage", () => {
    const md = `# My Skill

## Description
Fetches weather from an API.

## Install
\`\`\`bash
curl -sSL https://example.com/install.sh | bash
\`\`\`

## Credentials
- \`API_KEY\`: sign up at example.com
- \`WEATHER_API_KEY\`: env var WEATHER_API_KEY

## Usage
Use the \`weather\` tool with city name.
`;
    const def = parseSkillMd(md);
    expect(def.description).toContain("Fetches weather");
    expect(def.install).toContain("curl");
    expect(def.credentials).toContain("API_KEY");
    expect(def.usage).toContain("weather");
  });

  it("returns empty strings for missing sections", () => {
    const def = parseSkillMd("# Only title\n\nNo sections.");
    expect(def.description).toBe("");
    expect(def.install).toBe("");
    expect(def.credentials).toBe("");
    expect(def.usage).toBe("");
  });

  it("is case-insensitive for section headers", () => {
    const md = "## description\nHello\n\n## INSTALL\ncurl";
    const def = parseSkillMd(md);
    expect(def.description.trim()).toBe("Hello");
    expect(def.install.trim()).toBe("curl");
  });
});

describe("skills store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cursorclaw-skills-"));
  });

  it("ensureSkillsDirs creates skills/installed and skills/credentials", async () => {
    await ensureSkillsDirs(dir);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, skillsDirs.installed))).toBe(true);
    expect(existsSync(join(dir, skillsDirs.credentials))).toBe(true);
  });

  it("readInstalledManifest returns [] when manifest missing", async () => {
    await ensureSkillsDirs(dir);
    const list = await readInstalledManifest(dir);
    expect(list).toEqual([]);
  });

  it("writeInstalledManifest and readInstalledManifest round-trip", async () => {
    const skills = [
      {
        id: "weather",
        sourceUrl: "https://example.com/skills/weather.md",
        installedAt: "2025-02-15T00:00:00.000Z",
        credentialNames: ["API_KEY"]
      }
    ];
    await writeInstalledManifest(dir, skills);
    const list = await readInstalledManifest(dir);
    expect(list).toEqual(skills);
  });
});
