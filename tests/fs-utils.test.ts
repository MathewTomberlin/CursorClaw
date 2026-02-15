import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { safeReadUtf8 } from "../src/fs-utils.js";

let tempDir: string;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("safeReadUtf8", () => {
  it("returns undefined for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-missing-"));
    tempDir = dir;
    const out = await safeReadUtf8(join(dir, "nonexistent.txt"));
    expect(out).toBeUndefined();
  });

  it("returns content for valid UTF-8 file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-valid-"));
    tempDir = dir;
    const path = join(dir, "f.txt");
    await writeFile(path, "hello world\n", "utf8");
    const out = await safeReadUtf8(path);
    expect(out).toBe("hello world\n");
  });

  it("decodes invalid UTF-8 with replacement instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-invalid-"));
    tempDir = dir;
    const path = join(dir, "f.txt");
    await writeFile(path, Buffer.from([0x61, 0x62, 0xff, 0xfe, 0x63]), "binary");
    const out = await safeReadUtf8(path);
    expect(out).toBeDefined();
    expect(out).toContain("ab");
    expect(out).toContain("c");
  });

  it("truncates when maxChars is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-max-"));
    tempDir = dir;
    const path = join(dir, "f.txt");
    await writeFile(path, "a".repeat(200), "utf8");
    const out = await safeReadUtf8(path, { maxChars: 50 });
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(50 + 30);
    expect(out).toContain("truncated for length");
  });
});
