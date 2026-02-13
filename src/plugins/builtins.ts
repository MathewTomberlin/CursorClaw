import type { MemoryStore } from "../memory.js";
import type { RuntimeObservationStore } from "../runtime-observation.js";
import type {
  AnalyzerPlugin,
  CollectorPlugin,
  MemoryContextPayload,
  ObservationContextPayload,
  PluginArtifact,
  PluginContext,
  PluginInsight,
  PromptMessage,
  SynthesizerPlugin
} from "./types.js";

export class MemoryCollectorPlugin implements CollectorPlugin {
  readonly id = "memory-collector";

  constructor(
    private readonly memory: MemoryStore,
    private readonly allowSecret: boolean
  ) {}

  async collect(context: PluginContext): Promise<PluginArtifact[]> {
    const records = await this.memory.retrieveForSession({
      sessionId: context.sessionId,
      allowSecret: this.allowSecret
    });
    const payload: MemoryContextPayload = {
      records
    };
    return [
      {
        sourcePlugin: this.id,
        type: "memory-records",
        payload
      }
    ];
  }
}

export class ObservationCollectorPlugin implements CollectorPlugin {
  readonly id = "observation-collector";

  constructor(private readonly observations: RuntimeObservationStore) {}

  async collect(context: PluginContext): Promise<PluginArtifact[]> {
    const events = await this.observations.listRecent({
      sessionId: context.sessionId,
      limit: 8
    });
    const payload: ObservationContextPayload = {
      events
    };
    return [
      {
        sourcePlugin: this.id,
        type: "runtime-observations",
        payload
      }
    ];
  }
}

export class ContextAnalyzerPlugin implements AnalyzerPlugin {
  readonly id = "context-analyzer";

  async analyze(_context: PluginContext, artifacts: PluginArtifact[]): Promise<PluginInsight[]> {
    const insights: PluginInsight[] = [];
    for (const artifact of artifacts) {
      if (artifact.type === "memory-records") {
        const payload = artifact.payload as MemoryContextPayload;
        insights.push({
          sourcePlugin: this.id,
          type: "memory-summary",
          payload: payload.records.slice(-10).map((record) => `[${record.category}] ${record.text}`)
        });
      }
      if (artifact.type === "runtime-observations") {
        const payload = artifact.payload as ObservationContextPayload;
        if (payload.events.length > 0) {
          insights.push({
            sourcePlugin: this.id,
            type: "observation-summary",
            payload: payload.events.map((event) => `[${event.kind}] ${JSON.stringify(event.payload)}`)
          });
        }
      }
    }
    return insights;
  }
}

export class PromptSynthesizerPlugin implements SynthesizerPlugin {
  readonly id = "prompt-synthesizer";

  async synthesize(_context: PluginContext, insights: PluginInsight[]): Promise<PromptMessage[]> {
    const memorySummary = insights.find((insight) => insight.type === "memory-summary")?.payload as
      | string[]
      | undefined;
    const observationSummary = insights.find((insight) => insight.type === "observation-summary")?.payload as
      | string[]
      | undefined;
    const sections: string[] = [];
    if (memorySummary && memorySummary.length > 0) {
      sections.push(`Relevant session memory:\n${memorySummary.join("\n")}`);
    }
    if (observationSummary && observationSummary.length > 0) {
      sections.push(`Recent runtime observations:\n${observationSummary.join("\n")}`);
    }
    if (sections.length === 0) {
      return [];
    }
    return [
      {
        role: "system",
        content: sections.join("\n\n")
      }
    ];
  }
}
