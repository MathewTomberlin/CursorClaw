import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeObservationStore } from "../src/runtime-observation.js";
import { NetworkTraceCollector } from "../src/network/trace-collector.js";
import { WorkspaceCatalog } from "../src/workspaces/catalog.js";
import { CrossRepoDependencyGraphBuilder } from "../src/workspaces/cross-repo-graph.js";
import { MultiRootIndexer } from "../src/workspaces/multi-root-indexer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("workspace indexing and network tracing", () => {
  it("indexes multiple workspace roots and builds cross-repo dependency edges", async () => {
    const base = await mkdtemp(join(tmpdir(), "cursorclaw-workspaces-"));
    tempDirs.push(base);
    const repoA = join(base, "repo-a");
    const repoB = join(base, "repo-b");
    await mkdir(join(repoA, "src"), { recursive: true });
    await mkdir(join(repoB, "src"), { recursive: true });
    await writeFile(
      join(repoA, "src", "client.ts"),
      [
        "import { fetchUser } from 'repo-b/src/api';",
        "export async function loadUser() {",
        "  return fetch('http://localhost:3000/api/user').then((res) => res.json());",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(repoB, "src", "api.ts"),
      ["export function fetchUser(id: string) {", "  return { id };", "}"].join("\n"),
      "utf8"
    );

    const catalog = new WorkspaceCatalog({
      roots: [
        { id: "repo-a", path: repoA, enabled: true, priority: 0 },
        { id: "repo-b", path: repoB, enabled: true, priority: 1 }
      ]
    });
    const health = await catalog.healthCheck();
    expect(health.every((entry) => entry.healthy)).toBe(true);

    const indexer = new MultiRootIndexer({
      maxFilesPerRoot: 100,
      maxFileBytes: 64 * 1024,
      includeExtensions: [".ts"]
    });
    const indexed = await indexer.indexRoots(catalog.listRoots());
    expect(indexed.some((file) => file.repo === "repo-a")).toBe(true);
    expect(indexed.some((file) => file.repo === "repo-b")).toBe(true);

    const graph = new CrossRepoDependencyGraphBuilder().build(indexed);
    const importEdge = graph.edges.find((edge) => edge.kind === "import" && edge.fromRepo === "repo-a");
    expect(importEdge?.toRepo).toBe("repo-b");
  });

  it("ingests localhost traces, scrubs payloads, and rejects disallowed hosts", async () => {
    const base = await mkdtemp(join(tmpdir(), "cursorclaw-nettrace-"));
    tempDirs.push(base);
    const store = new RuntimeObservationStore({
      maxEvents: 100,
      stateFile: join(base, "observations.json")
    });
    await store.load();
    const collector = new NetworkTraceCollector({
      enabled: true,
      allowHosts: [],
      observationStore: store,
      getIndexedModulePaths: async () => ["src/api/user.ts", "src/client/app.ts"]
    });

    const accepted = await collector.ingest({
      sessionId: "s-trace",
      method: "POST",
      url: "http://localhost:3000/api/user",
      status: 500,
      latencyMs: 180,
      requestBody: {
        note: "token=abc123"
      },
      responseBody: {
        error: "password=hunter2"
      }
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.linkedModules.length).toBeGreaterThan(0);
    const recent = await store.listRecent({
      sessionId: "s-trace",
      limit: 1
    });
    const payloadText = JSON.stringify(recent[0]?.payload ?? {});
    expect(payloadText).toContain("[REDACTED]");
    expect(payloadText).not.toContain("hunter2");

    const denied = await collector.ingest({
      method: "GET",
      url: "https://example.com/api/data",
      status: 200,
      latencyMs: 20
    });
    expect(denied.accepted).toBe(false);
    expect(denied.reason).toMatch(/host not allowed/i);
  });
});
