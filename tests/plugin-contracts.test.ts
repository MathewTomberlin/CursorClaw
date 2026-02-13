import { describe, expectTypeOf, it } from "vitest";

import type {
  AnalyzerPlugin,
  CollectorPlugin,
  PluginArtifact,
  PluginContext,
  PluginInsight,
  PromptMessage,
  SynthesizerPlugin
} from "../src/plugins/types.js";

describe("plugin contract type guardrails", () => {
  it("collector/analyzer/synthesizer signatures remain stable", () => {
    const collector: CollectorPlugin = {
      id: "collector",
      collect: async (_context: PluginContext) =>
        [
          {
            sourcePlugin: "collector",
            type: "artifact",
            payload: {}
          }
        ] satisfies PluginArtifact[]
    };
    const analyzer: AnalyzerPlugin = {
      id: "analyzer",
      analyze: async (_context: PluginContext, _artifacts: PluginArtifact[]) =>
        [
          {
            sourcePlugin: "analyzer",
            type: "insight",
            payload: {}
          }
        ] satisfies PluginInsight[]
    };
    const synthesizer: SynthesizerPlugin = {
      id: "synthesizer",
      synthesize: async (_context: PluginContext, _insights: PluginInsight[]) =>
        [
          {
            role: "system",
            content: "hello"
          }
        ] satisfies PromptMessage[]
    };

    expectTypeOf(collector.collect).returns.toEqualTypeOf<Promise<PluginArtifact[]>>();
    expectTypeOf(analyzer.analyze).returns.toEqualTypeOf<Promise<PluginInsight[]>>();
    expectTypeOf(synthesizer.synthesize).returns.toEqualTypeOf<Promise<PromptMessage[]>>();
  });
});
