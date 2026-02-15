const STORAGE_KEY_BASE = "cursorclaw_base_url";
const STORAGE_KEY_TOKEN = "cursorclaw_token";

export function getBaseUrl(): string {
  try {
    const u = sessionStorage.getItem(STORAGE_KEY_BASE);
    if (u) return u.trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function getToken(): string {
  try {
    const t = sessionStorage.getItem(STORAGE_KEY_TOKEN);
    return t ?? "";
  } catch {
    return "";
  }
}

export function setAuth(baseUrl: string, token: string): void {
  sessionStorage.setItem(STORAGE_KEY_BASE, baseUrl.trim().replace(/\/$/, ""));
  sessionStorage.setItem(STORAGE_KEY_TOKEN, token);
}

export function clearAuth(): void {
  sessionStorage.removeItem(STORAGE_KEY_BASE);
  sessionStorage.removeItem(STORAGE_KEY_TOKEN);
}

export function isAuthenticated(): boolean {
  return getToken().length > 0;
}

export interface RpcError {
  code: string;
  message: string;
}

export interface RpcResponse<T = unknown> {
  id?: string;
  auditId: string;
  ok: boolean;
  result?: T;
  error?: RpcError;
}

function mapErrorCode(code: string): string {
  switch (code) {
    case "AUTH_MISSING":
      return "No token provided.";
    case "AUTH_INVALID":
      return "Invalid or expired token.";
    case "AUTH_ROLE_MISMATCH":
      return "You don't have permission for this action.";
    case "RATE_LIMITED":
      return "Rate limited. Please try again later.";
    case "RISK_BLOCKED":
      return "Request blocked by safety policy.";
    case "NOT_FOUND":
      return "Resource not found.";
    case "RUN_UNAVAILABLE":
      return "Run is no longer available.";
    case "FORBIDDEN":
      return "Action forbidden.";
    case "BAD_REQUEST":
      return "Invalid request.";
    case "PROTO_VERSION_UNSUPPORTED":
      return "Unsupported protocol version.";
    default:
      return "An error occurred.";
  }
}

export function mapRpcError(res: { status?: number; error?: RpcError }): string {
  if (res.status === 401) return "Invalid or expired token.";
  if (res.status === 403) return "Forbidden.";
  if (res.status === 404) return "Not found.";
  if (res.status === 413) return "Request too large (try a shorter thread or clear the chat).";
  if (res.status === 429) return "Rate limited. Please try again later.";
  if (res.error?.code) return mapErrorCode(res.error.code) + (res.error.message ? ` ${res.error.message}` : "");
  const status = res.status !== undefined ? ` (${res.status})` : "";
  return `Request failed${status}.`;
}

export async function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<RpcResponse<T>> {
  const base = getBaseUrl();
  const token = getToken();
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      version: "2.0",
      method,
      ...(params !== undefined ? { params } : {})
    })
  });
  let data: RpcResponse<T>;
  try {
    data = (await res.json()) as RpcResponse<T>;
  } catch (parseErr) {
    const text = await res.text().catch(() => "");
    const snippet = text.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(
      `Invalid response (${res.status}): ${snippet ? snippet + "…" : "empty or non-JSON body"}`
    );
  }
  if (!res.ok) {
    const err = new Error(data.error?.message ?? mapRpcError({ status: res.status, error: data.error }));
    (err as unknown as { status: number; rpcCode?: string }).status = res.status;
    (err as unknown as { rpcCode?: string }).rpcCode = data.error?.code;
    throw err;
  }
  if (!data.ok && data.error) {
    const err = new Error(data.error.message || mapErrorCode(data.error.code));
    (err as unknown as { rpcCode?: string }).rpcCode = data.error.code;
    throw err;
  }
  return data;
}

/** Call RPC with profileId merged into params. Use for profile-scoped RPCs (substrate, memory, heartbeat, approval, cron, workspace, etc.). */
export async function rpcWithProfile<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  profileId: string
): Promise<RpcResponse<T>> {
  const merged = { ...(params ?? {}), profileId };
  return rpc<T>(method, merged);
}

export async function getHealth(): Promise<{ ok: boolean; time: string }> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error("Health check failed.");
  return res.json();
}

export async function getStatus(): Promise<StatusPayload> {
  const base = getBaseUrl();
  const token = getToken();
  const res = await fetch(`${base}/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error("Status check failed.");
  return res.json();
}

/** Poll for a proactive message from a heartbeat turn for the given profile. Returns the message if one was pending (and clears it). */
export async function heartbeatPoll(profileId: string): Promise<{ result: string; proactiveMessage?: string }> {
  const res = await rpcWithProfile<{ result: string; proactiveMessage?: string }>("heartbeat.poll", undefined, profileId);
  const payload = res.result;
  return payload != null && typeof payload === "object" ? payload : { result: "ok" };
}

/** Read HEARTBEAT.md content (used on the next heartbeat run). */
export async function getHeartbeatFile(): Promise<{ content: string }> {
  const res = await rpc<{ content: string }>("heartbeat.getFile");
  const payload = res.result;
  return payload != null && typeof payload === "object" && typeof (payload as { content?: string }).content === "string"
    ? (payload as { content: string })
    : { content: "" };
}

/** Write HEARTBEAT.md content. Takes effect on the next heartbeat. */
export async function updateHeartbeat(content: string): Promise<void> {
  await rpc("heartbeat.update", { content });
}

export interface ProfileInfo {
  id: string;
  root: string;
  modelId?: string;
}

export interface StatusPayload {
  gateway: string;
  defaultModel: string;
  /** Agent profiles for the profile selector; when absent or empty, backend uses single default profile. */
  profiles?: ProfileInfo[];
  defaultProfileId?: string;
  queueWarnings: string[];
  /** If present, the agent sent a proactive message during a heartbeat (e.g. BIRTH); poll heartbeat.poll to consume. */
  pendingProactiveMessage?: string;
  runtimeMetrics: {
    turnsStarted: number;
    turnsCompleted: number;
    turnsFailed: number;
    toolCalls: number;
  };
  reliability: { multiPathResolutionsLast24h: { success: number; failure: number } };
  adapterMetrics: Record<string, unknown> & {
    lastFallbackError?: string | null;
    fallbackAttemptCount?: number;
    timeoutCount?: number;
    crashCount?: number;
  };
  schedulerBacklog: number;
  policyDecisions: number;
  approvals: { pending: number; activeCapabilities: number };
  incident: { proactiveSendsDisabled: boolean; toolIsolationEnabled: boolean };
}

/** Create a new agent profile. Requires admin/local auth. */
export async function profileCreate(id: string, root: string): Promise<{ profile: ProfileInfo; configPath: string }> {
  const res = await rpc<{ profile: ProfileInfo; configPath: string }>("profile.create", { id: id.trim(), root: root.trim() });
  const out = res.result;
  if (!out?.profile) throw new Error("Invalid response from profile.create");
  return out;
}

/** Delete an agent profile. Fails if it is the only profile. Requires admin/local auth. */
export async function profileDelete(id: string, removeDirectory?: boolean): Promise<void> {
  await rpc("profile.delete", { id: id.trim(), removeDirectory: removeDirectory === true });
}

/** Reload config from disk (openclaw.json). Applies without restart. Requires admin/local auth. */
export async function configReload(): Promise<void> {
  await rpc("config.reload");
}

/** Patch config with allowed keys (e.g. heartbeat, autonomyBudget). Writes to disk and applies in memory without restart. Requires admin/local auth. */
export async function configPatch(partial: Record<string, unknown>): Promise<void> {
  await rpc("config.patch", partial);
}

/** Restart the framework (runs full build, then restarts). Requires admin/local auth. */
export async function restartFramework(): Promise<{ buildRan?: boolean }> {
  const res = await rpc<{ buildRan?: boolean }>("admin.restart");
  return res.result ?? {};
}

/** Get persisted chat thread for a session (shared across desktop and mobile). Uses current profile when profileId is passed via rpcWithProfile. */
export async function getThread(
  sessionId: string,
  profileId: string
): Promise<{ messages: Array<{ id: string; role: "user" | "assistant"; content: string; at?: string }> }> {
  const res = await rpcWithProfile<{ messages: Array<{ id: string; role: "user" | "assistant"; content: string; at?: string }> }>(
    "chat.getThread",
    { sessionId: sessionId.trim() },
    profileId
  );
  const out = res.result;
  if (out == null || typeof out !== "object" || !Array.isArray((out as { messages?: unknown }).messages)) {
    return { messages: [] };
  }
  return out as { messages: Array<{ id: string; role: "user" | "assistant"; content: string; at?: string }> };
}

/** Persist chat thread for a session so desktop and Tailscale see the same messages. */
export async function setThread(
  sessionId: string,
  profileId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  await rpcWithProfile<{ ok?: boolean }>(
    "thread.set",
    {
      sessionId: sessionId.trim(),
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    },
    profileId
  );
}

/** Installed skill record (id, sourceUrl, installedAt, credentialNames). Values never returned. */
export interface InstalledSkillRecord {
  id: string;
  sourceUrl: string;
  installedAt: string;
  credentialNames: string[];
}

/** List installed skills for the profile. Requires admin/local auth. */
export async function skillsList(profileId: string): Promise<InstalledSkillRecord[]> {
  const res = await rpcWithProfile<{ skills: InstalledSkillRecord[] }>("skills.list", undefined, profileId);
  const skills = res.result?.skills;
  return Array.isArray(skills) ? skills : [];
}

/** Set a credential value for a skill. Value is never logged. Requires admin/local auth. */
export async function skillsCredentialsSet(
  profileId: string,
  skillId: string,
  keyName: string,
  value: string
): Promise<void> {
  await rpcWithProfile("skills.credentials.set", { skillId, keyName, value }, profileId);
}

/** Delete a credential for a skill. Requires admin/local auth. */
export async function skillsCredentialsDelete(
  profileId: string,
  skillId: string,
  keyName: string
): Promise<boolean> {
  const res = await rpcWithProfile<{ deleted?: boolean }>(
    "skills.credentials.delete",
    { skillId, keyName },
    profileId
  );
  return res.result?.deleted === true;
}

/** List credential names (no values) for a skill. Requires admin/local auth. */
export async function skillsCredentialsList(
  profileId: string,
  skillId: string
): Promise<string[]> {
  const res = await rpcWithProfile<{ names?: string[] }>(
    "skills.credentials.list",
    { skillId },
    profileId
  );
  const names = res.result?.names;
  return Array.isArray(names) ? names : [];
}

/** List credential names (no values) for a provider. Requires admin/local auth. */
export async function providerCredentialsList(
  profileId: string,
  providerId: string
): Promise<string[]> {
  const res = await rpcWithProfile<{ names?: string[] }>(
    "provider.credentials.list",
    { providerId },
    profileId
  );
  const names = res.result?.names;
  return Array.isArray(names) ? names : [];
}

/** Set a provider API key/credential. Value is never logged. Requires admin/local auth. */
export async function providerCredentialsSet(
  profileId: string,
  providerId: string,
  keyName: string,
  value: string
): Promise<void> {
  await rpcWithProfile("provider.credentials.set", { providerId, keyName, value }, profileId);
}

/** Delete a provider credential. Requires admin/local auth. */
export async function providerCredentialsDelete(
  profileId: string,
  providerId: string,
  keyName: string
): Promise<boolean> {
  const res = await rpcWithProfile<{ deleted?: boolean }>(
    "provider.credentials.delete",
    { providerId, keyName },
    profileId
  );
  return res.result?.deleted === true;
}

/** Result of provider.models.list: either models or an error (e.g. network, 401). */
export interface ProviderModelsListResult {
  models?: Array<{ id: string; name?: string }>;
  error?: { code: string; message: string };
}

/** List models from a provider (e.g. Ollama tags, OpenAI-compatible /models). For discovery only; profile model selection still uses config. Requires admin/local auth. */
export async function providerModelsList(
  profileId: string,
  providerId: string
): Promise<ProviderModelsListResult> {
  const res = await rpcWithProfile<{ models?: Array<{ id: string; name?: string }>; error?: { code: string; message: string } }>(
    "provider.models.list",
    { providerId },
    profileId
  );
  const out = res.result;
  if (out == null || typeof out !== "object") return {};
  if ("error" in out && out.error) return { error: out.error };
  return { models: Array.isArray(out.models) ? out.models : [] };
}

/** Opens SSE to /stream. Note: EventSource cannot send Authorization header; use same-origin or future stream-ticket flow for auth. */
export function openStream(sessionId?: string): EventSource {
  const base = getBaseUrl();
  const url = new URL(`${base}/stream`);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  return new EventSource(url.toString());
}
