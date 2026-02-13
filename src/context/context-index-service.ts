import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CrossRepoGraph } from "../workspaces/cross-repo-graph.js";
import { CrossRepoDependencyGraphBuilder } from "../workspaces/cross-repo-graph.js";
import type { WorkspaceCatalog } from "../workspaces/catalog.js";
import { MultiRootIndexer, type IndexedWorkspaceFile } from "../workspaces/multi-root-indexer.js";
import type { SemanticContextRetriever } from "./retriever.js";

export interface ContextIndexServiceOptions {
  workspaceCatalog: WorkspaceCatalog;
  retriever: SemanticContextRetriever;
  stateFile: string;
  refreshEveryMs: number;
  indexer: MultiRootIndexer;
  crossRepoGraphBuilder?: CrossRepoDependencyGraphBuilder;
}

interface IndexedFileState {
  modulePath: string;
  repo: string;
  workspaceId: string;
  contentHash: string;
  updatedAtMs: number;
}

interface PersistedContextIndexState {
  version: number;
  files: Record<string, IndexedFileState>;
}

const CONTEXT_INDEX_STATE_VERSION = 1;

export class ContextIndexService {
  private readonly fileState = new Map<string, IndexedFileState>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private lastRefreshAtMs = 0;
  private graph: CrossRepoGraph = {
    edges: [],
    builtAt: new Date(0).toISOString()
  };
  private readonly graphBuilder: CrossRepoDependencyGraphBuilder;

  constructor(private readonly options: ContextIndexServiceOptions) {
    this.graphBuilder = options.crossRepoGraphBuilder ?? new CrossRepoDependencyGraphBuilder();
  }

  async ensureFreshIndex(now = Date.now()): Promise<void> {
    await this.ensureLoaded();
    if (now - this.lastRefreshAtMs < this.options.refreshEveryMs) {
      return;
    }
    const roots = this.options.workspaceCatalog.listRoots();
    const files = await this.options.indexer.indexRoots(roots);
    await this.refreshFromFiles(files);
    this.graph = this.graphBuilder.build(files);
    this.lastRefreshAtMs = now;
  }

  getCrossRepoGraph(): CrossRepoGraph {
    return {
      builtAt: this.graph.builtAt,
      edges: this.graph.edges.map((edge) => ({ ...edge }))
    };
  }

  async listIndexedFiles(limit = 200): Promise<Array<IndexedFileState & { path: string }>> {
    await this.ensureLoaded();
    return [...this.fileState.entries()]
      .map(([path, state]) => ({ path, ...state }))
      .sort((lhs, rhs) => rhs.updatedAtMs - lhs.updatedAtMs)
      .slice(0, Math.max(1, limit));
  }

  private async refreshFromFiles(files: IndexedWorkspaceFile[]): Promise<void> {
    let changed = false;
    const seenPaths = new Set<string>();
    for (const file of files) {
      seenPaths.add(file.absolutePath);
      const existing = this.fileState.get(file.absolutePath);
      if (existing && existing.contentHash === file.contentHash) {
        continue;
      }
      await this.options.retriever.refreshModule({
        workspace: file.workspaceId,
        repo: file.repo,
        modulePath: file.modulePath,
        sourceText: file.content
      });
      this.fileState.set(file.absolutePath, {
        modulePath: file.modulePath,
        repo: file.repo,
        workspaceId: file.workspaceId,
        contentHash: file.contentHash,
        updatedAtMs: file.updatedAtMs
      });
      changed = true;
    }
    for (const path of [...this.fileState.keys()]) {
      if (seenPaths.has(path)) {
        continue;
      }
      this.fileState.delete(path);
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedContextIndexState;
      if (!parsed.files || typeof parsed.files !== "object") {
        return;
      }
      for (const [path, value] of Object.entries(parsed.files)) {
        if (!value?.modulePath || !value.repo || !value.workspaceId || !value.contentHash) {
          continue;
        }
        this.fileState.set(path, value);
      }
    } catch {
      // no persisted file yet
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.stateFile), { recursive: true });
      const payload: PersistedContextIndexState = {
        version: CONTEXT_INDEX_STATE_VERSION,
        files: Object.fromEntries(this.fileState.entries())
      };
      await writeFile(this.options.stateFile, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writeChain;
  }
}
