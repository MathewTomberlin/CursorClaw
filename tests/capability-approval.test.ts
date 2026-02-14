import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithPinnedDns } from "../src/network/ssrf-pin.js";
import { ApprovalWorkflow } from "../src/security/approval-workflow.js";
import { CapabilityStore } from "../src/security/capabilities.js";
import { CapabilityApprovalGate, ToolRouter, createExecTool, createWebFetchTool } from "../src/tools.js";

vi.mock("../src/network/ssrf-pin.js", () => ({
  fetchWithPinnedDns: vi.fn()
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("capability-based approvals", () => {
  it("creates pending approval requests for network calls without grants", async () => {
    const capabilityStore = new CapabilityStore();
    const approvalWorkflow = new ApprovalWorkflow({
      capabilityStore,
      defaultGrantTtlMs: 60_000,
      defaultGrantUses: 1
    });
    const gate = new CapabilityApprovalGate({
      devMode: false,
      approvalWorkflow,
      capabilityStore
    });
    const webFetch = createWebFetchTool({ approvalGate: gate });

    await expect(
      webFetch.execute({
        url: "https://1.1.1.1"
      })
    ).rejects.toThrow(/requires approval/i);

    const pending = approvalWorkflow.listRequests({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]?.requiredCapabilities).toContain("net.fetch");
  });

  it("consumes approved capability grants and requires re-approval after use", async () => {
    const capabilityStore = new CapabilityStore();
    const approvalWorkflow = new ApprovalWorkflow({
      capabilityStore,
      defaultGrantTtlMs: 60_000,
      defaultGrantUses: 1
    });
    const gate = new CapabilityApprovalGate({
      devMode: false,
      approvalWorkflow,
      capabilityStore
    });
    const webFetch = createWebFetchTool({ approvalGate: gate });

    vi.mocked(fetchWithPinnedDns).mockResolvedValue({
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/plain" : null) },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("hello").buffer)
    });

    await expect(
      webFetch.execute({
        url: "https://1.1.1.1"
      })
    ).rejects.toThrow(/requires approval/i);
    const request = approvalWorkflow.listRequests({ status: "pending" })[0];
    expect(request).toBeDefined();
    approvalWorkflow.resolve({
      requestId: request?.id ?? "",
      decision: "approve"
    });

    const first = (await webFetch.execute({
      url: "https://1.1.1.1"
    })) as { status: number; body: string };
    expect(first.status).toBe(200);
    expect(first.body).toContain("UNTRUSTED_EXTERNAL_CONTENT_START");

    await expect(
      webFetch.execute({
        url: "https://1.1.1.1"
      })
    ).rejects.toThrow(/requires approval/i);
  });

  it("denies injected network-impacting exec calls without capability grants", async () => {
    const capabilityStore = new CapabilityStore();
    const approvalWorkflow = new ApprovalWorkflow({
      capabilityStore,
      defaultGrantTtlMs: 60_000,
      defaultGrantUses: 1
    });
    const gate = new CapabilityApprovalGate({
      devMode: false,
      approvalWorkflow,
      capabilityStore
    });
    const router = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["curl"]
    });
    router.register(
      createExecTool({
        allowedBins: ["curl"],
        approvalGate: gate
      })
    );

    await expect(
      router.execute(
        {
          name: "exec",
          args: {
            command: "curl https://malicious.example.com"
          }
        },
        {
          auditId: "audit-injection-deny",
          decisionLogs: []
        }
      )
    ).rejects.toThrow(/requires approval/i);
    const pending = approvalWorkflow.listRequests({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);
  });

  it("denies untrusted-derived high-risk tool call without untrusted-scope grant", async () => {
    const capabilityStore = new CapabilityStore();
    const approvalWorkflow = new ApprovalWorkflow({
      capabilityStore,
      defaultGrantTtlMs: 60_000,
      defaultGrantUses: 1
    });
    const gate = new CapabilityApprovalGate({
      devMode: false,
      approvalWorkflow,
      capabilityStore
    });
    capabilityStore.grant({
      capability: "process.exec",
      scope: "exec:network-impacting",
      ttlMs: 60_000,
      uses: 1
    });
    const router = new ToolRouter({
      approvalGate: gate,
      allowedExecBins: ["curl"]
    });
    router.register(
      createExecTool({
        allowedBins: ["curl"],
        approvalGate: gate
      })
    );
    await expect(
      router.execute(
        {
          name: "exec",
          args: { command: "curl https://example.com" }
        },
        {
          auditId: "audit-untrusted",
          decisionLogs: [],
          provenance: "untrusted"
        }
      )
    ).rejects.toThrow(/requires approval|missing capability/i);
    const pending = approvalWorkflow.listRequests({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]?.provenance).toBe("untrusted");
  });
});
