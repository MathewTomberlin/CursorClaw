/**
 * Resolves apiKeyRef (from ModelProviderConfig) to a secret at request time.
 * Secrets are never logged or included in prompts; only used in outbound HTTP headers.
 *
 * Supported ref format: "env:VAR_NAME" — resolves to process.env[VAR_NAME].
 * Future: profile-scoped credential store keyed by ref.
 */
const ENV_PREFIX = "env:";

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
