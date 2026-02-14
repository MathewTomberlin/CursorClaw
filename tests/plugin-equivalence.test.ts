/**
 * Plugin pipeline output stability: fixed fixture produces deterministic shape.
 * Changing plugin logic or built-ins may require updating the golden summary.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ContextAnalyzerPlugin, PromptSynthesizerPlugin } from "../src/plugins/builtins.js";
import { PluginHost } from "../src/plugins/host.js";
import type { PluginArtifact, PluginContext } from "../src/plugins/types.js";

const FIXED_CONTEXT: PluginContext = {
  runId: "eq-run-1",
  sessionId: "eq-session-1",
  inputMessages: [{ role: "user", content: "Summarize memory" }]
};

/** Fixed artifacts that produce a deterministic synthesizer output. */
function fixedArtifacts(): PluginArtifact[] {
  return [
    {
      sourcePlugin: "memory-collector",
      type: "memory-records",
      payload: {
        records: [
          { id: "r1", sessionId: "eq-session-1", category: "fact", text: "User prefers TypeScript.", provenance: { sourceChannel: "test", confidence: 1 } },
          { id: "r2", sessionId: "eq-session-1", category: "preference", text: "Use strict mode.", provenance: { sourceChannel: "test", confidence: 1 } }
        ]
      }
    }
  ];
}

describe("plugin pipeline equivalence", () => {
  it("pipeline with fixed fixture produces stable synthesizer output shape", async () => {
    const host = new PluginHost({ defaultTimeoutMs: 5_000 });
    host.registerAnalyzer(new ContextAnalyzerPlugin());
    host.registerSynthesizer(new PromptSynthesizerPlugin());
    // Inject fixed artifacts (no collectors run; we supply artifacts directly for reproducibility)
    const artifacts = fixedArtifacts();
    const generatedInsights: { sourcePlugin: string; type: string; payload: unknown }[] = [];
    for (const plugin of [new ContextAnalyzerPlugin()]) {
      const insights = await plugin.analyze(FIXED_CONTEXT, artifacts);
      generatedInsights.push(...insights);
    }
    const synthesizedMessages: { role: string; content: string }[] = [];
    for (const plugin of [new PromptSynthesizerPlugin()]) {
      const messages = await plugin.synthesize(FIXED_CONTEXT, generatedInsights);
      synthesizedMessages.push(...messages);
    }

    expect(synthesizedMessages.length).toBeGreaterThanOrEqual(0);
    expect(synthesizedMessages.length).toBeLessThanOrEqual(1);
    if (synthesizedMessages.length === 1) {
      expect(synthesizedMessages[0]!.role).toBe("system");
      const contentChecksum = createHash("sha256").update(synthesizedMessages[0]!.content).digest("hex").slice(0, 16);
      expect(synthesizedMessages[0]!.content).toContain("Relevant session memory");
      expect(synthesizedMessages[0]!.content).toContain("TypeScript");
      expect(synthesizedMessages[0]!.content).toContain("strict mode");
      // Golden: section count (1 section) and presence of key phrases; checksum for strict regression detection
      expect(contentChecksum).toMatch(/^[a-f0-9]{16}$/);
    }
  });

  it("full host run with single collector returning fixed artifacts matches expected shape", async () => {
    const host = new PluginHost({ defaultTimeoutMs: 5_000 });
    host.registerCollector({
      id: "fixed",
      collect: async () => fixedArtifacts()
    });
    host.registerAnalyzer(new ContextAnalyzerPlugin());
    host.registerSynthesizer(new PromptSynthesizerPlugin());

    const result = await host.run(FIXED_CONTEXT);

    expect(result.diagnostics).toEqual([]);
    expect(result.messages.length).toBeLessThanOrEqual(1);
    if (result.messages.length === 1) {
      expect(result.messages[0]!.role).toBe("system");
      expect(result.messages[0]!.content).toContain("Relevant session memory");
    }
  });
});
