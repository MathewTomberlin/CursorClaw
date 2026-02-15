/**
 * Resolves apiKeyRef (from ModelProviderConfig) to a secret at request time.
 * Secrets are never logged or included in prompts; only used in outbound HTTP headers.
 *
 * Supported ref formats:
 * - "env:VAR_NAME" — resolves to process.env[VAR_NAME] (sync).
 * - "profile:providerId" or "profile:providerId.keyName" — resolves from profile-scoped provider credential store (async; requires profileRoot).
 */

import { getProviderCredential } from "./provider-credentials.js";

const ENV_PREFIX = "env:";
const PROFILE_PREFIX = "profile:";
const DEFAULT_PROVIDER_KEY_NAME = "apiKey";

export function resolveApiKey(apiKeyRef: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!apiKeyRef || typeof apiKeyRef !== "string") {
    return undefined;
  }
  const trimmed = apiKeyRef.trim();
  if (!trimmed.startsWith(ENV_PREFIX)) {
    return undefined;
  }
  const varName = trimmed.slice(ENV_PREFIX.length).trim();
  if (!varName) {
    return undefined;
  }
  const value = env[varName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns true if apiKeyRef uses the profile: prefix (requires async resolution with profileRoot).
 */
export function isProfileApiKeyRef(apiKeyRef: string | undefined): boolean {
  if (!apiKeyRef || typeof apiKeyRef !== "string") return false;
  return apiKeyRef.trim().startsWith(PROFILE_PREFIX);
}

/**
 * Async resolution: supports env: (resolved sync from env) and profile:providerId or profile:providerId.keyName (from profile store).
 * When profileRoot is missing and ref is profile:, returns undefined.
 */
export async function resolveApiKeyAsync(
  apiKeyRef: string | undefined,
  profileRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (!apiKeyRef || typeof apiKeyRef !== "string") return undefined;
  const trimmed = apiKeyRef.trim();

  if (trimmed.startsWith(ENV_PREFIX)) {
    return resolveApiKey(apiKeyRef, env);
  }

  if (!trimmed.startsWith(PROFILE_PREFIX) || !profileRoot) return undefined;
  const rest = trimmed.slice(PROFILE_PREFIX.length).trim();
  if (!rest) return undefined;

  const dot = rest.indexOf(".");
  const providerId = dot >= 0 ? rest.slice(0, dot).trim() : rest;
  const keyName = dot >= 0 ? rest.slice(dot + 1).trim() : DEFAULT_PROVIDER_KEY_NAME;
  if (!providerId || !/^[a-zA-Z0-9_-]+$/.test(providerId) || !/^[a-zA-Z0-9_-]+$/.test(keyName)) {
    return undefined;
  }

  return getProviderCredential(profileRoot, providerId, keyName);
}
