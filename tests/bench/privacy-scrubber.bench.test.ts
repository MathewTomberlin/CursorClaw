/**
 * Scrubber performance benchmark and guardrail.
 * Ensures scrubber overhead stays bounded; threshold can be relaxed only with explicit approval.
 * Run with: npm test -- tests/bench/privacy-scrubber.bench.test.ts
 */
import { describe, expect, it } from "vitest";

import { PrivacyScrubber } from "../../src/privacy/privacy-scrubber.js";

const FIXTURE_SIZE_KB = 10;
const ITERATIONS = 100;
/** Median scrub time (ms) must stay below this. Relax only with explicit PR approval. */
const MEDIAN_MS_THRESHOLD = 150;

function buildFixture(): string {
  const secretLike = [
    "token = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE2MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  ];
  const filler =
    "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
  let text = "";
  while (text.length < FIXTURE_SIZE_KB * 1024) {
    text += filler;
    for (const s of secretLike) {
      text += "\n" + s + "\n";
    }
  }
  return text.slice(0, FIXTURE_SIZE_KB * 1024);
}

describe("privacy scrubber benchmark", () => {
  it("scrubber median time stays under threshold on fixed fixture", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const fixture = buildFixture();
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      scrubber.scrubText({ text: fixture, scopeId: "bench" });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(ITERATIONS / 2)]!;
    expect(median).toBeLessThanOrEqual(MEDIAN_MS_THRESHOLD);
  });
});
