import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExperienceStore } from "../src/continuity/experience-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("experience store", () => {
  it("adds and queries experiences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-store-"));
    tempDirs.push(dir);
    const store = new ExperienceStore({
      stateFile: join(dir, "exp.json"),
      maxExperiences: 100,
      uniquenessThreshold: 0.9
    });
    await store.load();

    await store.add({
      text: "User prefers dark mode and keyboard shortcuts",
      category: "user-preference",
      sessionId: "s1"
    });
    await store.add({
      text: "We fixed the login bug by validating the token",
      category: "note",
      sessionId: "s1"
    });

    const results = await store.query({ query: "user preferences dark mode", topK: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.text).toContain("dark mode");
    expect(results[0]!.score).toBeGreaterThan(0);

    const results2 = await store.query({ query: "login bug fix", topK: 5 });
    expect(results2.length).toBeGreaterThanOrEqual(1);
    const loginResult = results2.find((r) => r.text.includes("login"));
    expect(loginResult).toBeDefined();
    expect(loginResult!.text).toContain("login");
  });

  it("isUnique returns false for similar text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-unique-"));
    tempDirs.push(dir);
    const store = new ExperienceStore({
      stateFile: join(dir, "exp.json"),
      maxExperiences: 100,
      uniquenessThreshold: 0.85
    });
    await store.load();

    await store.add({
      text: "The user prefers to run tests before committing code",
      category: "note",
      sessionId: "s1"
    });

    const unique = await store.isUnique("The user prefers to run tests before committing");
    expect(unique).toBe(false);
  });

  it("isUnique returns true for different text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-unique2-"));
    tempDirs.push(dir);
    const store = new ExperienceStore({
      stateFile: join(dir, "exp.json"),
      maxExperiences: 100,
      uniquenessThreshold: 0.85
    });
    await store.load();

    await store.add({
      text: "User prefers dark mode",
      category: "note",
      sessionId: "s1"
    });

    const unique = await store.isUnique("We deployed the new API to production yesterday");
    expect(unique).toBe(true);
  });

  it("persists and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-persist-"));
    tempDirs.push(dir);
    const stateFile = join(dir, "exp.json");
    const store1 = new ExperienceStore({ stateFile, maxExperiences: 100 });
    await store1.load();
    await store1.add({
      text: "Persisted experience about deployment",
      category: "note",
      sessionId: "s1"
    });

    const store2 = new ExperienceStore({ stateFile, maxExperiences: 100 });
    await store2.load();
    expect(store2.size()).toBe(1);
    const results = await store2.query({ query: "deployment", topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0]!.text).toContain("deployment");
  });
});
