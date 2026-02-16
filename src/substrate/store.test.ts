import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SubstrateStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SubstrateStore", () => {
  it("get returns empty when nothing set", () => {
    const store = new SubstrateStore();
    expect(store.get()).toEqual({});
  });

  it("set and get round-trip", () => {
    const store = new SubstrateStore();
    store.set({ identity: "I am Bot.", soul: "Be kind." });
    expect(store.get()).toEqual({ identity: "I am Bot.", soul: "Be kind." });
  });

  it("reload loads from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-store-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "IDENTITY.md"), "Identity content.", "utf8");
    const store = new SubstrateStore();
    await store.reload(dir);
    expect(store.get().identity).toBe("Identity content.");
  });

  it("writeKey rejects invalid key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-write-"));
    tempDirs.push(dir);
    const store = new SubstrateStore();
    await expect(
      store.writeKey(dir, undefined, "invalid", "x")
    ).rejects.toThrow(/Invalid substrate key/);
  });

  it("writeKey writes file and updates cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-write-"));
    tempDirs.push(dir);
    const store = new SubstrateStore();
    await store.writeKey(dir, undefined, "identity", "New identity.");
    expect(store.get().identity).toBe("New identity.");
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(dir, "IDENTITY.md"), "utf8");
    expect(onDisk).toBe("New identity.");
  });

  it("ensureDefaults creates missing files with default content but not BIRTH.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-ensure-"));
    tempDirs.push(dir);
    const store = new SubstrateStore();
    await store.reload(dir);
    expect(store.get()).toEqual({});
    await store.ensureDefaults(dir, undefined);
    const content = store.get();
    expect(content.identity).toBeDefined();
    expect(content.identity).toContain("IDENTITY.md");
    expect(content.soul).toBeDefined();
    expect(content.birth).toBeUndefined();
    const { readFile, access } = await import("node:fs/promises");
    const onDisk = await readFile(join(dir, "IDENTITY.md"), "utf8");
    expect(onDisk.trim()).toBe(content.identity);
    await expect(access(join(dir, "BIRTH.md"))).rejects.toThrow();
  });

  it("ensureDefaults with includeBirth: true creates BIRTH.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substrate-ensure-birth-"));
    tempDirs.push(dir);
    const store = new SubstrateStore();
    await store.reload(dir);
    await store.ensureDefaults(dir, undefined, { includeBirth: true });
    const content = store.get();
    expect(content.birth).toBeDefined();
    expect(content.birth).toContain("BIRTH");
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(dir, "BIRTH.md"), "utf8");
    expect(onDisk.trim()).toBe(content.birth);
  });
});
