import { describe, expect, it } from "vitest";

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
});
