/**
 * Profile-scoped credential store for LLM providers (e.g. API keys for openai-compatible).
 * Keys are (profileRoot, providerId, keyName). Values are never returned to the agent or included in prompts/logs.
 * Use only for runtime resolution when calling provider APIs; never inject into model context.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CREDENTIALS_DIR = "credentials";
const PROVIDERS_FILE = "providers.json";

const SAFE_PROVIDER_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_KEY_NAME = /^[a-zA-Z0-9_-]+$/;

function assertSafeProviderId(providerId: string): void {
  if (!SAFE_PROVIDER_ID.test(providerId)) {
    throw new Error("providerId must match [a-zA-Z0-9_-]+");
  }
}

function assertSafeKeyName(keyName: string): void {
  if (!SAFE_KEY_NAME.test(keyName)) {
    throw new Error("keyName must match [a-zA-Z0-9_-]+");
  }
}

function providersPath(profileRoot: string): string {
  return join(profileRoot, CREDENTIALS_DIR, PROVIDERS_FILE);
}

async function ensureCredentialsDir(profileRoot: string): Promise<void> {
  await mkdir(join(profileRoot, CREDENTIALS_DIR), { recursive: true });
}

type ProvidersData = Record<string, Record<string, string>>;

async function readProvidersFile(profileRoot: string): Promise<ProvidersData> {
  const path = providersPath(profileRoot);
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (data === null || typeof data !== "object") return {};
    const out: ProvidersData = {};
    for (const [providerId, keys] of Object.entries(data)) {
      if (typeof providerId !== "string" || !SAFE_PROVIDER_ID.test(providerId)) continue;
      if (keys === null || typeof keys !== "object") continue;
      const keyMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string" && SAFE_KEY_NAME.test(k))
          keyMap[k] = v;
      }
      if (Object.keys(keyMap).length > 0) out[providerId] = keyMap;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Get a provider credential value. Only use in secure runtime paths (e.g. outbound API calls); never pass to the model or logs.
 */
export async function getProviderCredential(
  profileRoot: string,
  providerId: string,
  keyName: string
): Promise<string | undefined> {
  assertSafeProviderId(providerId);
  assertSafeKeyName(keyName);
  const data = await readProvidersFile(profileRoot);
  const providerKeys = data[providerId];
  return providerKeys?.[keyName];
}

/**
 * Set a provider credential value. Value is never logged.
 */
export async function setProviderCredential(
  profileRoot: string,
  providerId: string,
  keyName: string,
  value: string
): Promise<void> {
  assertSafeProviderId(providerId);
  assertSafeKeyName(keyName);
  await ensureCredentialsDir(profileRoot);
  const data = await readProvidersFile(profileRoot);
  if (!data[providerId]) data[providerId] = {};
  data[providerId][keyName] = value;
  await writeFile(providersPath(profileRoot), JSON.stringify(data, null, 0), "utf8");
}

/**
 * Delete a provider credential by key name.
 */
export async function deleteProviderCredential(
  profileRoot: string,
  providerId: string,
  keyName: string
): Promise<boolean> {
  assertSafeProviderId(providerId);
  assertSafeKeyName(keyName);
  const data = await readProvidersFile(profileRoot);
  const providerKeys = data[providerId];
  if (!providerKeys || !(keyName in providerKeys)) return false;
  delete providerKeys[keyName];
  if (Object.keys(providerKeys).length === 0) delete data[providerId];
  await writeFile(providersPath(profileRoot), JSON.stringify(data, null, 0), "utf8");
  return true;
}

/**
 * List credential names for a provider. Returns names only; never returns values.
 */
export async function listProviderCredentialNames(
  profileRoot: string,
  providerId: string
): Promise<string[]> {
  assertSafeProviderId(providerId);
  const data = await readProvidersFile(profileRoot);
  const providerKeys = data[providerId];
  return providerKeys ? Object.keys(providerKeys) : [];
}

/**
 * List provider ids that have at least one stored credential.
 */
export async function listProvidersWithCredentials(profileRoot: string): Promise<string[]> {
  const data = await readProvidersFile(profileRoot);
  return Object.keys(data).filter((id) => {
    const creds = data[id];
    return Object.keys(creds != null ? creds : {}).length > 0;
  });
}
