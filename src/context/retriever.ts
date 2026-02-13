import type { SemanticSummaryRecord } from "./summary-cache.js";
import { LocalEmbeddingIndex, type EmbeddingQueryResult } from "./embedding-index.js";
import { SemanticSummaryCache } from "./summary-cache.js";

export interface SemanticContextHit {
  workspace: string;
  repo: string;
  modulePath: string;
  score: number;
  summary?: SemanticSummaryRecord;
  chunkText: string;
  chunkIndex: number;
}

export interface SemanticContextRetrieverOptions {
  summaryCache: SemanticSummaryCache;
  embeddingIndex: LocalEmbeddingIndex;
}

export class SemanticContextRetriever {
  constructor(private readonly options: SemanticContextRetrieverOptions) {}

  async retrieve(args: {
    query: string;
    topK: number;
    workspace?: string;
    repo?: string;
    allowSecret?: boolean;
  }): Promise<SemanticContextHit[]> {
    const hits = await this.options.embeddingIndex.query({
      query: args.query,
      topK: args.topK,
      ...(args.workspace ? { workspace: args.workspace } : {}),
      ...(args.repo ? { repo: args.repo } : {}),
      allowSecret: args.allowSecret ?? false
    });
    const out: SemanticContextHit[] = [];
    for (const hit of hits) {
      out.push({
        workspace: hit.chunk.workspace,
        repo: hit.chunk.repo,
        modulePath: hit.chunk.modulePath,
        score: hit.score,
        summary: await this.options.summaryCache.get({
          workspace: hit.chunk.workspace,
          repo: hit.chunk.repo,
          modulePath: hit.chunk.modulePath
        }),
        chunkText: hit.chunk.text,
        chunkIndex: hit.chunk.chunkIndex
      });
    }
    return out;
  }

  rankByModule(hits: SemanticContextHit[]): Array<{
    workspace: string;
    repo: string;
    modulePath: string;
    maxScore: number;
    averageScore: number;
    summary?: SemanticSummaryRecord;
    chunks: SemanticContextHit[];
  }> {
    const grouped = new Map<string, SemanticContextHit[]>();
    for (const hit of hits) {
      const key = `${hit.workspace}:${hit.repo}:${hit.modulePath}`;
      const list = grouped.get(key) ?? [];
      list.push(hit);
      grouped.set(key, list);
    }
    const ranked = [...grouped.values()].map((entries) => {
      const first = entries[0];
      const sum = entries.reduce((acc, item) => acc + item.score, 0);
      const max = entries.reduce((acc, item) => Math.max(acc, item.score), 0);
      return {
        workspace: first?.workspace ?? "unknown",
        repo: first?.repo ?? "unknown",
        modulePath: first?.modulePath ?? "unknown",
        maxScore: max,
        averageScore: sum / Math.max(1, entries.length),
        summary: first?.summary,
        chunks: entries.sort((lhs, rhs) => rhs.score - lhs.score)
      };
    });
    return ranked.sort((lhs, rhs) => rhs.maxScore - lhs.maxScore);
  }

  async refreshModule(args: {
    workspace: string;
    repo: string;
    modulePath: string;
    sourceText: string;
  }): Promise<void> {
    await this.options.summaryCache.upsertFromSource({
      workspace: args.workspace,
      repo: args.repo,
      modulePath: args.modulePath,
      sourceText: args.sourceText
    });
    await this.options.embeddingIndex.upsertModule({
      workspace: args.workspace,
      repo: args.repo,
      modulePath: args.modulePath,
      sourceText: args.sourceText,
      sensitivity: "operational"
    });
  }

  async listRecentEmbeddings(args?: {
    workspace?: string;
    repo?: string;
    limit?: number;
  }): Promise<EmbeddingQueryResult[]> {
    const chunks = await this.options.embeddingIndex.listChunks(args);
    return chunks.map((chunk) => ({
      chunk,
      score: 0
    }));
  }
}
