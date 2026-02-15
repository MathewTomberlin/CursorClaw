/**
 * Provider/model validation result store (PMR Phase 1).
 * Persists per-model probe results; no secrets. See docs/PMR-provider-model-resilience.md.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Per-check result for Phase 2; Phase 1 only runs minimal probe (tool call + done). */
export interface ValidationChecks {
  toolCall?: boolean;
  reasoning?: boolean;
}

export interface ValidationResultEntry {
  passed: boolean;
  lastRun: string;
  checks: ValidationChecks;
  error: string | null;
}

export interface ProviderModelValidationStore {
  lastUpdated: string;
  results: Record<string, ValidationResultEntry>;
}

const DEFAULT_STORE: ProviderModelValidationStore = {
  lastUpdated: new Date().toISOString(),
  results: {}
};

/**
 * Resolve validation store path: config value or default run/provider-model-validation.json relative to cwd.
 */
export function resolveValidationStorePath(
  configPath: string | undefined,
  cwd: string
): string {
  const relative = configPath ?? "run/provider-model-validation.json";
  return resolve(cwd, relative);
}

/**
 * Read the validation store from disk. Returns default shape if file missing or invalid.
 */
export async function readValidationStore(
  absolutePath: string
): Promise<ProviderModelValidationStore> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_STORE };
    }
    const obj = parsed as Record<string, unknown>;
    const lastUpdated =
      typeof obj.lastUpdated === "string" ? obj.lastUpdated : new Date().toISOString();
    const results: Record<string, ValidationResultEntry> = {};
    if (obj.results && typeof obj.results === "object" && !Array.isArray(obj.results)) {
      for (const [modelId, entry] of Object.entries(obj.results)) {
        if (entry && typeof entry === "object" && typeof (entry as ValidationResultEntry).passed === "boolean") {
          const e = entry as ValidationResultEntry;
          results[modelId] = {
            passed: e.passed,
            lastRun: typeof e.lastRun === "string" ? e.lastRun : new Date().toISOString(),
            checks: e.checks && typeof e.checks === "object" ? e.checks : {},
            error: typeof e.error === "string" ? e.error : null
          };
        }
      }
    }
    return { lastUpdated, results };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

/**
 * Write the full store to disk. Ensures parent directory exists.
 */
export async function writeValidationStore(
  absolutePath: string,
  store: ProviderModelValidationStore
): Promise<void> {
  const dir = dirname(absolutePath);
  await mkdir(dir, { recursive: true });
  const payload: ProviderModelValidationStore = {
    ...store,
    lastUpdated: new Date().toISOString()
  };
  await writeFile(absolutePath, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Returns true if the store has a passed result for the given model id.
 */
export async function isModelValidated(
  absolutePath: string,
  modelId: string
): Promise<boolean> {
  const store = await readValidationStore(absolutePath);
  return store.results[modelId]?.passed === true;
}

/**
 * Update the result for one model and persist. Does not store secrets; error should be redacted.
 */
export async function updateValidationResult(
  absolutePath: string,
  modelId: string,
  entry: ValidationResultEntry
): Promise<void> {
  const store = await readValidationStore(absolutePath);
  store.results[modelId] = {
    ...entry,
    lastRun: new Date().toISOString()
  };
  store.lastUpdated = new Date().toISOString();
  await writeValidationStore(absolutePath, store);
}
