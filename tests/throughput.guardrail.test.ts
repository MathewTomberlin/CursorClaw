import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { AlwaysAllowApprovalGate, ToolRouter } from "../src/tools.js";

describe("throughput guardrails", () => {
  it("maintains tool router throughput baseline for repeated low-risk calls", async () => {
    const router = new ToolRouter({
      approvalGate: new AlwaysAllowApprovalGate(),
      allowedExecBins: ["echo"]
    });
    router.register({
      name: "noop",
      description: "No-op tool for throughput baseline checks",
      schema: {
        type: "object",
        properties: {
          value: {
            type: "number"
          }
        },
        required: ["value"],
        additionalProperties: false
      },
      riskLevel: "low",
      execute: async () => ({ ok: true })
    });

    const start = performance.now();
    for (let idx = 0; idx < 750; idx += 1) {
      await router.execute(
        {
          name: "noop",
          args: {
            value: idx
          }
        },
        {
          auditId: `audit-throughput-${idx}`,
          decisionLogs: []
        }
      );
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
