import type { SemanticContextRetriever } from "../context/retriever.js";
import type { CollectorPlugin, PluginArtifact, PluginContext } from "./types.js";

export interface SemanticContextCollectorOptions {
  retriever: SemanticContextRetriever;
  workspace?: string;
  repo?: string;
  topK: number;
  allowSecret?: boolean;
  ensureFreshIndex?: () => Promise<void>;
  resolveCrossRepoSuspects?: (repo: string) => string[];
}

export class SemanticContextCollectorPlugin implements CollectorPlugin {
  readonly id = "semantic-context-collector";
  readonly timeoutMs = 2_500;

  constructor(private readonly options: SemanticContextCollectorOptions) {}

  async collect(context: PluginContext): Promise<PluginArtifact[]> {
    await this.options.ensureFreshIndex?.();
    const query = buildSemanticQuery(context.inputMessages.map((message) => message.content));
    if (!query) {
      return [];
    }
    const hits = await this.options.retriever.retrieve({
      query,
      topK: this.options.topK,
      ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
      ...(this.options.repo ? { repo: this.options.repo } : {}),
      allowSecret: this.options.allowSecret ?? false
    });
    if (hits.length === 0) {
      return [];
    }
    const grouped = this.options.retriever.rankByModule(hits).slice(0, 8);
    return [
      {
        sourcePlugin: this.id,
        type: "semantic-context",
        payload: {
          query,
          modules: grouped.map((entry) => ({
            workspace: entry.workspace,
            repo: entry.repo,
            modulePath: entry.modulePath,
            maxScore: entry.maxScore,
            crossRepoSuspects: this.options.resolveCrossRepoSuspects?.(entry.repo) ?? [],
            summary: entry.summary?.summary ?? "",
            symbols: entry.summary?.symbols ?? [],
            chunks: entry.chunks.slice(0, 2).map((chunk) => ({
              score: chunk.score,
              chunkIndex: chunk.chunkIndex,
              text: chunk.chunkText
            }))
          }))
        }
      }
    ];
  }
}

function buildSemanticQuery(messages: string[]): string {
  const joined = messages.join("\n").trim();
  if (!joined) {
    return "";
  }
  return joined.slice(-2_000);
}
