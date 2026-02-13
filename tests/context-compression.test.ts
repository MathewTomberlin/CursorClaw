import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEmbeddingIndex } from "../src/context/embedding-index.js";
import { SemanticContextRetriever } from "../src/context/retriever.js";
import { SemanticSummaryCache } from "../src/context/summary-cache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("context compression primitives", () => {
  it("builds summaries, invalidates by content hash, and redacts secret-like values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-context-summary-"));
    tempDirs.push(dir);
    const summaryCache = new SemanticSummaryCache({
      stateFile: join(dir, "summary.json"),
      maxEntries: 200
    });
    await summaryCache.load();

    const first = await summaryCache.upsertFromSource({
      workspace: "ws-main",
      repo: "repo-main",
      modulePath: "src/auth.ts",
      sourceText: [
        "export function login(password: string) {",
        "  const token = 'ghp_SECRET_123';",
        "  return password + token;",
        "}"
      ].join("\n")
    });

    expect(first.summary.toLowerCase()).not.toContain("ghp_secret_123".toLowerCase());
    expect(first.summary).toContain("token=[REDACTED]");

    const second = await summaryCache.upsertFromSource({
      workspace: "ws-main",
      repo: "repo-main",
      modulePath: "src/auth.ts",
      sourceText: [
        "export function login(password: string) {",
        "  return password.trim();",
        "}"
      ].join("\n")
    });

    expect(second.contentHash).not.toBe(first.contentHash);
    const loaded = await summaryCache.get({
      workspace: "ws-main",
      repo: "repo-main",
      modulePath: "src/auth.ts"
    });
    expect(loaded?.contentHash).toBe(second.contentHash);
  });

  it("recovers from corrupted summary cache state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-context-corruption-"));
    tempDirs.push(dir);
    const stateFile = join(dir, "summary.json");
    await writeFile(stateFile, "{ broken-json ", "utf8");

    const cache = new SemanticSummaryCache({
      stateFile,
      maxEntries: 50
    });
    await expect(cache.load()).resolves.toBeUndefined();
    await expect(
      cache.upsertFromSource({
        workspace: "ws-1",
        repo: "repo-1",
        modulePath: "src/a.ts",
        sourceText: "export const value = 1;"
      })
    ).resolves.toBeDefined();
  });

  it("retrieves semantically relevant Top-K chunks with provenance metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursorclaw-context-retriever-"));
    tempDirs.push(dir);
    const summaryCache = new SemanticSummaryCache({
      stateFile: join(dir, "summary.json"),
      maxEntries: 500
    });
    const embeddingIndex = new LocalEmbeddingIndex({
      stateFile: join(dir, "embedding.json"),
      maxChunks: 2_000
    });
    await summaryCache.load();
    await embeddingIndex.load();
    const retriever = new SemanticContextRetriever({
      summaryCache,
      embeddingIndex
    });

    await retriever.refreshModule({
      workspace: "ws-app",
      repo: "repo-app",
      modulePath: "src/auth/login.ts",
      sourceText: [
        "export function validateLoginToken(token: string) {",
        "  if (!token.startsWith('jwt-')) return false;",
        "  return token.length > 20;",
        "}"
      ].join("\n")
    });
    await retriever.refreshModule({
      workspace: "ws-app",
      repo: "repo-app",
      modulePath: "src/render/ui.ts",
      sourceText: [
        "export function renderButton(label: string) {",
        "  return `<button>${label}</button>`;",
        "}"
      ].join("\n")
    });

    const hits = await retriever.retrieve({
      query: "login token validation bug",
      topK: 3,
      workspace: "ws-app",
      repo: "repo-app"
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.modulePath).toContain("auth/login.ts");
    expect(hits[0]?.summary?.modulePath).toBe("src/auth/login.ts");
    expect(hits[0]?.score ?? 0).toBeGreaterThan(0);
  });
});
