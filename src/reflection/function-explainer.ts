import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FunctionExplanation {
  symbol: string;
  summary: string;
  sideEffects: string[];
  likelyCallers: string[];
  recentHistory: string[];
  confidence: number;
}

export interface FunctionExplainerOptions {
  workspaceDir: string;
}

export class FunctionExplainer {
  constructor(private readonly options: FunctionExplainerOptions) {}

  async explain(args: {
    modulePath: string;
    sourceText: string;
    symbol: string;
    callerHints?: string[];
  }): Promise<FunctionExplanation> {
    const extracted = extractSymbolBlock(args.sourceText, args.symbol);
    const sideEffects = extractSideEffects(extracted.block);
    const recentHistory = await this.readRecentHistory(args.modulePath);
    const summary = extracted.block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 6)
      .join(" ");
    return {
      symbol: args.symbol,
      summary: summary || `${args.symbol} definition not found in module.`,
      sideEffects,
      likelyCallers: (args.callerHints ?? []).slice(0, 8),
      recentHistory,
      confidence: extracted.found ? 78 : 42
    };
  }

  private async readRecentHistory(modulePath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-n", "5", "--pretty=format:%h %ad %s", "--date=short", "--", modulePath],
        {
          cwd: this.options.workspaceDir,
          timeout: 5_000,
          maxBuffer: 512 * 1024,
          windowsHide: true
        }
      );
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}

function extractSymbolBlock(sourceText: string, symbol: string): { found: boolean; block: string } {
  const pattern = new RegExp(
    `(function\\s+${escapeRegExp(symbol)}\\s*\\(|class\\s+${escapeRegExp(symbol)}\\b|const\\s+${escapeRegExp(symbol)}\\s*=)`,
    "m"
  );
  const match = pattern.exec(sourceText);
  if (!match) {
    return {
      found: false,
      block: ""
    };
  }
  const start = match.index;
  const slice = sourceText.slice(start);
  const lines = slice.split("\n").slice(0, 60);
  return {
    found: true,
    block: lines.join("\n")
  };
}

function extractSideEffects(block: string): string[] {
  const effects: string[] = [];
  if (!block) {
    return effects;
  }
  if (/\b(writeFile|appendFile|unlink|rm|mkdir|rename)\b/.test(block)) {
    effects.push("filesystem-writes");
  }
  if (/\b(fetch|axios|http\.request|https\.request)\b/.test(block)) {
    effects.push("network-calls");
  }
  if (/\b(exec|spawn|execFile)\b/.test(block)) {
    effects.push("process-execution");
  }
  if (/\b(setTimeout|setInterval|cron)\b/.test(block)) {
    effects.push("scheduler-effects");
  }
  return effects;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
