import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

import { PrivacyScrubber } from "../src/privacy/privacy-scrubber.js";
import { SecretScanner } from "../src/privacy/secret-scanner.js";

describe("privacy scrubber", () => {
  it("detects and redacts common secret patterns", () => {
    const scanner = new SecretScanner();
    const scan = scanner.scan(
      "token=abcd1234efgh5678ijkl9012 and ghp_abcdefghijklmnopqrstuvwxyz123456"
    );
    expect(scan.findings.length).toBeGreaterThanOrEqual(2);

    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const result = scrubber.scrubText({
      text: "password=my-secret-password-123",
      scopeId: "session-a:run-1"
    });
    expect(result.scrubbed).toBe(true);
    expect(result.text).toContain("[SECRET_ASSIGNMENT_1]");
    expect(result.text).not.toContain("my-secret-password-123");
  });

  it("uses stable placeholders within one scope", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const first = scrubber.scrubText({
      text: "api_key=alpha123alpha123",
      scopeId: "scope-one"
    }).text;
    const second = scrubber.scrubText({
      text: "api_key=alpha123alpha123",
      scopeId: "scope-one"
    }).text;
    const third = scrubber.scrubText({
      text: "api_key=alpha123alpha123",
      scopeId: "scope-two"
    }).text;
    expect(first).toBe(second);
    expect(third).toContain("[SECRET_ASSIGNMENT_1]");
  });

  it("scrubs nested object payloads recursively", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const payload = {
      level1: {
        token: "token=supersecret123456",
        array: ["ghp_abcdefghijklmnopqrstuvwxyz123456"]
      }
    };
    const scrubbed = scrubber.scrubUnknown(payload, "scope-nested") as {
      level1: { token: string; array: string[] };
    };
    expect(scrubbed.level1.token).not.toContain("supersecret123456");
    expect(scrubbed.level1.array[0]).not.toContain("ghp_");
  });

  it("redacts PEM private key blocks", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const result = scrubber.scrubText({
      text: pem,
      scopeId: "pem-scope"
    });
    expect(result.text).not.toContain("BEGIN PRIVATE KEY");
    expect(result.text).toContain("PRIVATE_KEY_BLOCK");
  });

  it("keeps scrubber throughput within baseline for medium payloads", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const payload = `token=alpha-token-1234567890 ${"x".repeat(4_000)} ghp_abcdefghijklmnopqrstuvwxyz123456`;
    const start = performance.now();
    for (let idx = 0; idx < 400; idx += 1) {
      scrubber.scrubText({
        text: payload,
        scopeId: `perf-${idx % 5}`
      });
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it("covers at least twenty secret-like formats and avoids simple false positives", () => {
    const scrubber = new PrivacyScrubber({
      enabled: true,
      failClosedOnError: true
    });
    const cases = [
      "token=abc1234567890secret",
      "password=abc1234567890secret",
      "secret=abc1234567890secret",
      "api_key=abc1234567890secret",
      "api-key=abc1234567890secret",
      "token:abc1234567890secret",
      "token = abc1234567890secret",
      "password:\"abc1234567890secret\"",
      "secret='abc1234567890secret'",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "gho_abcdefghijklmnopqrstuvwxyz123456",
      "ghu_abcdefghijklmnopqrstuvwxyz123456",
      "ghs_abcdefghijklmnopqrstuvwxyz123456",
      "ghr_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "ASIAABCDEFGHIJKLMNOP",
      "A3TABCDEFGHIJKLMNOPQ",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepayload",
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      "QmFzZTY0VG9rZW5TdHJpbmdXaXRoSGlnaEVudHJvcHlBbmRMZW5ndGg9"
    ];
    for (const sample of cases) {
      const result = scrubber.scrubText({
        text: sample,
        scopeId: "coverage-20"
      });
      expect(result.text, `expected sample to be scrubbed: ${sample}`).not.toBe(sample);
    }

    const falsePositives = [
      "token=short",
      "password=small",
      "this sentence has no secret material",
      "hello world"
    ];
    for (const sample of falsePositives) {
      const result = scrubber.scrubText({
        text: sample,
        scopeId: "false-positive"
      });
      expect(result.text).toBe(sample);
    }
  });
});
