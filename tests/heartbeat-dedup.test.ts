import { describe, it, expect } from "vitest";
import {
  removeAllButFirstSummaryParagraph,
  removeDuplicateSummaryParagraph,
  removeDuplicatedTrailingParagraph,
  removeDuplicatedTrailingSuffix
} from "../src/runtime.js";

describe("heartbeat dedup helpers", () => {
  describe("removeDuplicatedTrailingSuffix", () => {
    it("removes exact duplicated trailing suffix when duplicate is immediate", () => {
      // Whole string duplicated with no separator: "XY" + "XY" → "XY"
      expect(removeDuplicatedTrailingSuffix("XYXY")).toBe("XY");
      expect(removeDuplicatedTrailingSuffix("abab")).toBe("ab");
    });

    it("returns text unchanged when no duplicate suffix", () => {
      expect(removeDuplicatedTrailingSuffix("Hello world.")).toBe("Hello world.");
      expect(removeDuplicatedTrailingSuffix("A\n\nB\n\nC")).toBe("A\n\nB\n\nC");
    });
  });

  describe("removeDuplicatedTrailingParagraph", () => {
    it("removes last paragraph when it duplicates an earlier one", () => {
      expect(removeDuplicatedTrailingParagraph("A\n\nB\n\nA")).toBe("A\n\nB");
      expect(removeDuplicatedTrailingParagraph("Summary: done.\n\nSummary: done.")).toBe(
        "Summary: done."
      );
    });

    it("returns text unchanged when no duplicate paragraph", () => {
      expect(removeDuplicatedTrailingParagraph("A\n\nB\n\nC")).toBe("A\n\nB\n\nC");
    });
  });

  describe("removeDuplicateSummaryParagraph", () => {
    it("removes trailing summary-like paragraph when an earlier summary-like paragraph exists", () => {
      const text =
        "Progress: did X.\n\nSummary: Completed the task and updated ROADMAP.\n\nIn summary: All items are done.";
      expect(removeDuplicateSummaryParagraph(text)).toBe(
        "Progress: did X.\n\nSummary: Completed the task and updated ROADMAP."
      );
    });

    it("removes multiple trailing summary paragraphs (re-runs until no change)", () => {
      const text =
        "Done.\n\nSummary: First.\n\nIn short: Second summary.\n\nBottom line: Third.";
      const result = removeDuplicateSummaryParagraph(text);
      expect(result).toBe("Done.\n\nSummary: First.");
    });

    it("leaves text unchanged when last paragraph is not summary-like", () => {
      const text = "Progress: did X.\n\nNext steps: do Y.";
      expect(removeDuplicateSummaryParagraph(text)).toBe(text);
    });

    it("leaves text unchanged when only one summary-like paragraph", () => {
      const text = "Progress: did X.\n\nSummary: Only one summary here.";
      expect(removeDuplicateSummaryParagraph(text)).toBe(text);
    });

    it("recognizes summary-like prefixes (TL;DR, Wrap-up, Overall)", () => {
      const text = "A\n\nSummary: First.\n\nTL;DR: Same again.";
      expect(removeDuplicateSummaryParagraph(text)).toBe("A\n\nSummary: First.");
    });
  });

  describe("removeAllButFirstSummaryParagraph", () => {
    it("removes second summary in the middle (rephrased continuation case)", () => {
      const text =
        "Progress: did X.\n\nSummary: Completed the task.\n\nNext: did Y.\n\nIn summary: All set for this tick.";
      expect(removeAllButFirstSummaryParagraph(text)).toBe(
        "Progress: did X.\n\nSummary: Completed the task.\n\nNext: did Y."
      );
    });

    it("keeps first summary and drops only later summary-like paragraphs", () => {
      const text = "A\n\nSummary: First.\n\nB\n\nTL;DR: Second summary.";
      expect(removeAllButFirstSummaryParagraph(text)).toBe(
        "A\n\nSummary: First.\n\nB"
      );
    });

    it("leaves text unchanged when only one summary-like paragraph", () => {
      const text = "Progress: did X.\n\nSummary: Only one summary here.";
      expect(removeAllButFirstSummaryParagraph(text)).toBe(text);
    });

    it("leaves text unchanged when no summary-like paragraph", () => {
      const text = "Progress: did X.\n\nNext steps: do Y.";
      expect(removeAllButFirstSummaryParagraph(text)).toBe(text);
    });

    it("removes rephrased wrap-up in middle (e.g. That's it for / All set for this tick)", () => {
      const text =
        "Progress: did X.\n\nSummary: Completed the task.\n\nThat's it for this tick. No further updates.";
      expect(removeAllButFirstSummaryParagraph(text)).toBe(
        "Progress: did X.\n\nSummary: Completed the task."
      );
    });
  });
});
