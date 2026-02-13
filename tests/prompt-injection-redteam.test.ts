import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scoreInboundRisk, wrapUntrustedContent } from "../src/security.js";

interface RedTeamCase {
  id: string;
  trusted: boolean;
  text: string;
  recentTriggerCount: number;
  expectedMinRisk: number;
}

describe("prompt-injection red-team corpus", () => {
  it("scores corpus samples at or above expected thresholds and wraps content", async () => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "prompt-injection-corpus.json");
    const raw = await readFile(fixturePath, "utf8");
    const corpus = JSON.parse(raw) as RedTeamCase[];
    expect(Array.isArray(corpus)).toBe(true);
    expect(corpus.length).toBeGreaterThan(0);

    for (const sample of corpus) {
      const score = scoreInboundRisk({
        senderTrusted: sample.trusted,
        recentTriggerCount: sample.recentTriggerCount,
        text: sample.text
      });
      expect(score, `risk score mismatch for corpus case ${sample.id}`).toBeGreaterThanOrEqual(
        sample.expectedMinRisk
      );

      const wrapped = wrapUntrustedContent(sample.text);
      expect(wrapped).toContain("[UNTRUSTED_EXTERNAL_CONTENT_START]");
      expect(wrapped).toContain("[UNTRUSTED_EXTERNAL_CONTENT_END]");
    }
  });
});
