import { createHash } from "node:crypto";

import {
  SecretScanner,
  type SecretFinding,
  type SecretDetectorName
} from "./secret-scanner.js";

export interface PrivacyScrubResult {
  text: string;
  scrubbed: boolean;
  findings: Array<Omit<SecretFinding, "value">>;
  placeholderMap: Record<string, string>;
}

export interface PrivacyScrubberOptions {
  enabled: boolean;
  failClosedOnError: boolean;
  detectors?: SecretDetectorName[];
}

export class PrivacyScrubber {
  private readonly scanner: SecretScanner;
  private readonly placeholderByScope = new Map<string, Map<string, string>>();
  private readonly scopeCounters = new Map<string, number>();

  constructor(private readonly options: PrivacyScrubberOptions) {
    this.scanner = new SecretScanner(
      options.detectors !== undefined
        ? {
            detectors: options.detectors
          }
        : {}
    );
  }

  scrubText(args: { text: string; scopeId: string }): PrivacyScrubResult {
    if (!this.options.enabled) {
      return {
        text: args.text,
        scrubbed: false,
        findings: [],
        placeholderMap: {}
      };
    }
    try {
      const scan = this.scanner.scan(args.text);
      if (scan.findings.length === 0) {
        return {
          text: args.text,
          scrubbed: false,
          findings: [],
          placeholderMap: {}
        };
      }
      const perScopeMap = this.getScopeMap(args.scopeId);
      let cursor = 0;
      let out = "";
      const mapping: Record<string, string> = {};
      for (const finding of scan.findings) {
        out += args.text.slice(cursor, finding.start);
        const placeholder = this.placeholderFor(args.scopeId, finding.label, finding.value);
        out += placeholder;
        cursor = finding.end;
        mapping[placeholder] = hashValue(finding.value);
      }
      out += args.text.slice(cursor);
      return {
        text: out,
        scrubbed: true,
        findings: scan.findings.map((finding) => ({
          detector: finding.detector,
          label: finding.label,
          start: finding.start,
          end: finding.end,
          confidence: finding.confidence
        })),
        placeholderMap: sanitizePlaceholderMap(mapping, perScopeMap)
      };
    } catch (error) {
      if (this.options.failClosedOnError) {
        throw error;
      }
      return {
        text: args.text,
        scrubbed: false,
        findings: [],
        placeholderMap: {}
      };
    }
  }

  scrubUnknown(value: unknown, scopeId: string): unknown {
    if (!this.options.enabled) {
      return value;
    }
    if (typeof value === "string") {
      return this.scrubText({ text: value, scopeId }).text;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.scrubUnknown(entry, scopeId));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = this.scrubUnknown(entry, scopeId);
      }
      return out;
    }
    return value;
  }

  clearScope(scopeId: string): void {
    this.placeholderByScope.delete(scopeId);
    this.scopeCounters.delete(scopeId);
  }

  private placeholderFor(scopeId: string, label: string, rawValue: string): string {
    const map = this.getScopeMap(scopeId);
    const existing = map.get(rawValue);
    if (existing) {
      return existing;
    }
    const nextIndex = (this.scopeCounters.get(scopeId) ?? 0) + 1;
    this.scopeCounters.set(scopeId, nextIndex);
    const safeLabel = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const placeholder = `[${safeLabel}_${nextIndex}]`;
    map.set(rawValue, placeholder);
    return placeholder;
  }

  private getScopeMap(scopeId: string): Map<string, string> {
    const existing = this.placeholderByScope.get(scopeId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, string>();
    this.placeholderByScope.set(scopeId, created);
    return created;
  }
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizePlaceholderMap(
  map: Record<string, string>,
  scopePlaceholders: Map<string, string>
): Record<string, string> {
  if (Object.keys(map).length > 0) {
    return map;
  }
  const out: Record<string, string> = {};
  for (const [raw, placeholder] of scopePlaceholders.entries()) {
    out[placeholder] = hashValue(raw);
  }
  return out;
}
