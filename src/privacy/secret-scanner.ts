export type SecretDetectorName =
  | "generic-assignment"
  | "github-token"
  | "aws-access-key-id"
  | "jwt"
  | "private-key-block"
  | "high-entropy-token";

export interface SecretFinding {
  detector: SecretDetectorName;
  label: string;
  start: number;
  end: number;
  value: string;
  confidence: number;
}

export interface SecretScanResult {
  findings: SecretFinding[];
}

export interface SecretScannerOptions {
  detectors?: SecretDetectorName[];
  maxFindings?: number;
  maxScanChars?: number;
}

const DEFAULT_MAX_FINDINGS = 200;
const DEFAULT_MAX_SCAN_CHARS = 300_000;

const DEFAULT_DETECTORS: SecretDetectorName[] = [
  "generic-assignment",
  "github-token",
  "aws-access-key-id",
  "jwt",
  "private-key-block",
  "high-entropy-token"
];

function shannonEntropy(input: string): number {
  if (!input) {
    return 0;
  }
  const freq = new Map<string, number>();
  for (const char of input) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function addMatches(args: {
  text: string;
  regex: RegExp;
  detector: SecretDetectorName;
  label: string;
  confidence: number;
  findings: SecretFinding[];
  maxFindings: number;
  valueGroup?: number;
}): void {
  if (args.findings.length >= args.maxFindings) {
    return;
  }
  const scanRegex = new RegExp(args.regex.source, args.regex.flags.includes("g") ? args.regex.flags : `${args.regex.flags}g`);
  let match: RegExpExecArray | null = scanRegex.exec(args.text);
  while (match !== null) {
    if (args.findings.length >= args.maxFindings) {
      return;
    }
    const fullMatch = match[0] ?? "";
    if (!fullMatch) {
      match = scanRegex.exec(args.text);
      continue;
    }
    const capturedValue = args.valueGroup !== undefined ? (match[args.valueGroup] ?? fullMatch) : fullMatch;
    const valueStartOffset =
      args.valueGroup !== undefined
        ? fullMatch.indexOf(capturedValue)
        : 0;
    const start = (match.index ?? 0) + Math.max(0, valueStartOffset);
    const end = start + capturedValue.length;
    args.findings.push({
      detector: args.detector,
      label: args.label,
      start,
      end,
      value: capturedValue,
      confidence: args.confidence
    });
    match = scanRegex.exec(args.text);
  }
}

export class SecretScanner {
  private readonly detectors: SecretDetectorName[];
  private readonly maxFindings: number;
  private readonly maxScanChars: number;

  constructor(options: SecretScannerOptions = {}) {
    this.detectors = options.detectors ?? DEFAULT_DETECTORS;
    this.maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
    this.maxScanChars = options.maxScanChars ?? DEFAULT_MAX_SCAN_CHARS;
  }

  scan(inputText: string): SecretScanResult {
    const text = inputText.slice(0, this.maxScanChars);
    const findings: SecretFinding[] = [];
    const enabled = new Set(this.detectors);

    if (enabled.has("generic-assignment")) {
      addMatches({
        text,
        regex: /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*["']?([^\s,"'`]{8,})["']?/gi,
        detector: "generic-assignment",
        label: "SECRET_ASSIGNMENT",
        confidence: 0.82,
        findings,
        maxFindings: this.maxFindings,
        valueGroup: 2
      });
    }

    if (enabled.has("github-token")) {
      addMatches({
        text,
        regex: /\bgh[pousr]_[a-zA-Z0-9_]{20,}\b/g,
        detector: "github-token",
        label: "GITHUB_TOKEN",
        confidence: 0.98,
        findings,
        maxFindings: this.maxFindings
      });
    }

    if (enabled.has("aws-access-key-id")) {
      addMatches({
        text,
        regex: /\b(A3T[A-Z0-9]{17}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g,
        detector: "aws-access-key-id",
        label: "AWS_ACCESS_KEY_ID",
        confidence: 0.95,
        findings,
        maxFindings: this.maxFindings
      });
    }

    if (enabled.has("jwt")) {
      addMatches({
        text,
        regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
        detector: "jwt",
        label: "JWT_TOKEN",
        confidence: 0.88,
        findings,
        maxFindings: this.maxFindings
      });
    }

    if (enabled.has("private-key-block")) {
      addMatches({
        text,
        regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
        detector: "private-key-block",
        label: "PRIVATE_KEY_BLOCK",
        confidence: 0.99,
        findings,
        maxFindings: this.maxFindings
      });
    }

    if (enabled.has("high-entropy-token")) {
      const candidateRegex = /\b([A-Za-z0-9+/_=-]{24,})\b/g;
      let match: RegExpExecArray | null = candidateRegex.exec(text);
      while (match !== null) {
        if (findings.length >= this.maxFindings) {
          break;
        }
        const token = match[1] ?? "";
        // Skip path-like tokens so agent file refs and workspace links are preserved in proactive messages
        const looksLikePath = /[/\\]/.test(token) || /^[A-Za-z]:/.test(token);
        if (
          token.length >= 28 &&
          shannonEntropy(token) >= 4.0 &&
          !looksLikePath
        ) {
          findings.push({
            detector: "high-entropy-token",
            label: "HIGH_ENTROPY_TOKEN",
            start: match.index ?? 0,
            end: (match.index ?? 0) + token.length,
            value: token,
            confidence: 0.74
          });
        }
        match = candidateRegex.exec(text);
      }
    }

    findings.sort((lhs, rhs) => {
      if (lhs.start !== rhs.start) {
        return lhs.start - rhs.start;
      }
      return rhs.end - lhs.end;
    });
    return {
      findings: collapseOverlappingFindings(findings).slice(0, this.maxFindings)
    };
  }
}

function collapseOverlappingFindings(findings: SecretFinding[]): SecretFinding[] {
  if (findings.length <= 1) {
    return findings;
  }
  const out: SecretFinding[] = [];
  let previous = findings[0];
  if (!previous) {
    return [];
  }
  for (let index = 1; index < findings.length; index += 1) {
    const current = findings[index];
    if (!current) {
      continue;
    }
    if (current.start < previous.end) {
      // Keep the higher-confidence (or wider if confidence equal) finding.
      const previousRange = previous.end - previous.start;
      const currentRange = current.end - current.start;
      if (
        current.confidence > previous.confidence ||
        (current.confidence === previous.confidence && currentRange > previousRange)
      ) {
        previous = current;
      }
      continue;
    }
    out.push(previous);
    previous = current;
  }
  out.push(previous);
  return out;
}

export const DEFAULT_SECRET_SCANNER_DETECTORS = [...DEFAULT_DETECTORS];
