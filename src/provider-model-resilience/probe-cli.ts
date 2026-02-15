#!/usr/bin/env node
/**
 * CLI for running the provider/model validation probe (PMR Phase 1–2).
 * Usage: npm run validate-model -- --modelId=<id> [--config=<path>] [--fullSuite]
 * --fullSuite: run capability suite (tool call + reasoning). Default: tool-call only (Phase 1).
 * Exit code 0 if probe passed, non-zero otherwise. No API keys in args or logs.
 */

import { resolve } from "node:path";

import { loadConfigFromDisk } from "../config.js";
import { redactSecrets } from "../security.js";
import { runProbe } from "./probe.js";
import {
  resolveValidationStorePath,
  updateValidationResult
} from "./validation-store.js";

function parseArgv(argv: string[]): { modelId: string | null; configPath: string | null; fullSuite: boolean } {
  let modelId: string | null = null;
  let configPath: string | null = null;
  let fullSuite = false;
  for (const arg of argv) {
    if (arg.startsWith("--modelId=")) {
      modelId = arg.slice("--modelId=".length).trim() || null;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length).trim() || null;
    } else if (arg === "--fullSuite") {
      fullSuite = true;
    }
  }
  return { modelId, configPath, fullSuite };
}

async function main(): Promise<number> {
  const { modelId, configPath, fullSuite } = parseArgv(process.argv.slice(2));
  if (!modelId) {
    console.error("Usage: npm run validate-model -- --modelId=<id> [--config=<path>] [--fullSuite]");
    return 2;
  }

  const cwd = process.cwd();
  const options = configPath ? { configPath: resolve(cwd, configPath) } : { cwd };
  const config = loadConfigFromDisk(options);
  const storePath = resolveValidationStorePath(
    config.providerModelResilience?.validationStorePath,
    cwd
  );

  // PMR Phase 2: refuse to validate paid APIs unless operator opt-in
  const modelConfig = config.models[modelId];
  if (modelConfig?.paidApi === true && config.providerModelResilience?.runValidationAgainstPaidApis !== true) {
    console.error(`validate-model: ${modelId} is marked paidApi; set providerModelResilience.runValidationAgainstPaidApis to true to allow validation.`);
    return 2;
  }

  const result = await runProbe(modelId, config, { fullSuite });
  const entry = {
    passed: result.passed,
    lastRun: new Date().toISOString(),
    checks: result.checks,
    error: result.error ? redactSecrets(result.error) : null
  };
  await updateValidationResult(storePath, modelId, entry);

  if (result.passed) {
    console.log(`validate-model: ${modelId} passed`);
    return 0;
  }
  console.error(`validate-model: ${modelId} failed: ${redactSecrets(result.error ?? "unknown")}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("validate-model error:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
