import { clampConfidence } from "./action-envelope.js";

export interface ConfidenceInput {
  failureCount: number;
  hasDeepScan: boolean;
  pluginDiagnosticCount: number;
  toolCallCount: number;
  hasRecentTestsPassing: boolean;
}

export interface ConfidenceOutput {
  score: number;
  rationale: string[];
}

export class ConfidenceModel {
  score(input: ConfidenceInput): ConfidenceOutput {
    let score = 82;
    const rationale: string[] = [];

    if (input.failureCount > 0) {
      score -= Math.min(35, input.failureCount * 12);
      rationale.push(`failure_count=${input.failureCount}`);
    }
    if (input.pluginDiagnosticCount > 0) {
      score -= Math.min(15, input.pluginDiagnosticCount * 4);
      rationale.push(`plugin_diagnostics=${input.pluginDiagnosticCount}`);
    }
    if (input.toolCallCount > 8) {
      score -= Math.min(12, input.toolCallCount - 8);
      rationale.push(`high_tool_call_volume=${input.toolCallCount}`);
    }
    if (input.hasDeepScan) {
      score += 8;
      rationale.push("deep_scan_enabled");
    }
    if (input.hasRecentTestsPassing) {
      score += 10;
      rationale.push("recent_tests_passing");
    } else {
      rationale.push("recent_tests_not_confirmed");
    }

    return {
      score: clampConfidence(score),
      rationale
    };
  }
}
