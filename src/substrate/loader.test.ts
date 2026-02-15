import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSubstrate } from "./loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("substrate loader", () => {
  it("returns empty content when no files exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-empty-"));
    tempDirs.push(dir);
    const content = await loadSubstrate(dir);
    expect(content.agents).toBeUndefined();
    expect(content.identity).toBeUndefined();
    expect(content.soul).toBeUndefined();
    expect(content.birth).toBeUndefined();
    expect(content.capabilities).toBeUndefined();
    expect(content.user).toBeUndefined();
    expect(content.tools).toBeUndefined();
  });

  it("reads present files and trims content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-present-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "AGENTS.md"), "Session: read SOUL and USER.\n", "utf8");
    await writeFile(join(dir, "IDENTITY.md"), "  I am TestBot.\n  ", "utf8");
    await writeFile(join(dir, "SOUL.md"), "Be helpful and concise.\n", "utf8");
    const content = await loadSubstrate(dir);
    expect(content.agents).toBe("Session: read SOUL and USER.");
    expect(content.identity).toBe("I am TestBot.");
    expect(content.soul).toBe("Be helpful and concise.");
    expect(content.birth).toBeUndefined();
    expect(content.capabilities).toBeUndefined();
    expect(content.user).toBeUndefined();
    expect(content.tools).toBeUndefined();
  });

  it("uses custom paths when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-custom-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "custom_identity.md"), "Custom identity.", "utf8");
    const content = await loadSubstrate(dir, { identityPath: "custom_identity.md" });
    expect(content.identity).toBe("Custom identity.");
    expect(content.soul).toBeUndefined();
  });

  it("does not throw on missing files (ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-missing-"));
    tempDirs.push(dir);
    await expect(loadSubstrate(dir)).resolves.toEqual({});
  });

  it("omits key when file is empty after trim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-empty-file-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "IDENTITY.md"), "   \n\n  ", "utf8");
    const content = await loadSubstrate(dir);
    expect(content.identity).toBeUndefined();
  });
});
