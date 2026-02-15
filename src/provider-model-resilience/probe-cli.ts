#!/usr/bin/env node
/**
 * CLI for running the provider/model validation probe (PMR Phase 1).
 * Usage: npm run validate-model -- --modelId=<id> [--config=<path>]
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

function parseArgv(argv: string[]): { modelId: string | null; configPath: string | null } {
  let modelId: string | null = null;
  let configPath: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--modelId=")) {
      modelId = arg.slice("--modelId=".length).trim() || null;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length).trim() || null;
    }
  }
  return { modelId, configPath };
}

async function main(): Promise<number> {
  const { modelId, configPath } = parseArgv(process.argv.slice(2));
  if (!modelId) {
    console.error("Usage: npm run validate-model -- --modelId=<id> [--config=<path>]");
    return 2;
  }

  const cwd = process.cwd();
  const options = configPath ? { configPath: resolve(cwd, configPath) } : { cwd };
  const config = loadConfigFromDisk(options);
  const storePath = resolveValidationStorePath(
    config.providerModelResilience?.validationStorePath,
    cwd
  );

  const result = await runProbe(modelId, config);
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
