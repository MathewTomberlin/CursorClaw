import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import {
  rpc,
  mapRpcError,
  profileCreate,
  profileDelete,
  configReload,
  configPatch,
  providerCredentialsList,
  providerCredentialsSet,
  providerCredentialsDelete,
  providerModelsList
} from "../api";
import { useProfile } from "../contexts/ProfileContext";

interface HeartbeatConfig {
  enabled?: boolean;
  everyMs?: number;
  minMs?: number;
  maxMs?: number;
}

export default function Config() {
  const [config, setConfig] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { profiles, defaultProfileId, selectedProfileId, setSelectedProfileId, refreshProfiles } = useProfile();
  const profilesRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  const [createId, setCreateId] = useState("");
  const [createRoot, setCreateRoot] = useState("profiles/");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; removeDirectory: boolean } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [heartbeatDraft, setHeartbeatDraft] = useState<HeartbeatConfig | null>(null);
  const [heartbeatPatchBusy, setHeartbeatPatchBusy] = useState(false);
  const [heartbeatPatchError, setHeartbeatPatchError] = useState<string | null>(null);

  const [bindAddressDraft, setBindAddressDraft] = useState<string>("");
  const [bindAddressPatchBusy, setBindAddressPatchBusy] = useState(false);
  const [bindAddressPatchError, setBindAddressPatchError] = useState<string | null>(null);

  /** Provider API keys: providers that support profile-stored credentials (apiKeyRef). */
  const PROVIDER_IDS_WITH_CREDENTIALS = ["openai-compatible"];
  const [providerKeys, setProviderKeys] = useState<Record<string, string[]>>({});
  const [providerKeysLoading, setProviderKeysLoading] = useState(false);
  const [providerKeySetBusy, setProviderKeySetBusy] = useState(false);
  const [providerKeySetError, setProviderKeySetError] = useState<string | null>(null);
  const [providerKeyAddKeyName, setProviderKeyAddKeyName] = useState("apiKey");
  const [providerKeyAddValue, setProviderKeyAddValue] = useState("");
  const [providerKeyAddProviderId, setProviderKeyAddProviderId] = useState("openai-compatible");
  const [providerKeyDeleteBusy, setProviderKeyDeleteBusy] = useState<string | null>(null);

  /** Model selection: refresh from provider and set profile modelId. */
  const PROVIDER_IDS_WITH_MODEL_LIST = ["cursor-agent-cli", "ollama", "openai-compatible"];
  const [modelListProviderId, setModelListProviderId] = useState("ollama");
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [modelListLoading, setModelListLoading] = useState(false);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [profileModelIdDraft, setProfileModelIdDraft] = useState<string>("");
  const [profileModelSaveBusy, setProfileModelSaveBusy] = useState(false);
  const [profileModelSaveError, setProfileModelSaveError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setError(null);
    try {
      const res = await rpc("config.get");
      setConfig(res.result);
      const c = res.result as Record<string, unknown>;
      if (c?.heartbeat && typeof c.heartbeat === "object") {
        const h = c.heartbeat as HeartbeatConfig;
        setHeartbeatDraft({ enabled: h.enabled, everyMs: h.everyMs, minMs: h.minMs, maxMs: h.maxMs });
      }
      const gw = c?.gateway as { bind?: string; bindAddress?: string } | undefined;
      if (gw && typeof gw === "object") {
        setBindAddressDraft(typeof gw.bindAddress === "string" ? gw.bindAddress : "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchConfig();
    })();
  }, [fetchConfig]);

  useEffect(() => {
    if (location.hash === "#profiles" && profilesRef.current) {
      profilesRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [location.hash]);

  const fetchProviderKeys = useCallback(async () => {
    const pid = selectedProfileId;
    if (!pid) {
      setProviderKeys({});
      return;
    }
    setProviderKeysLoading(true);
    try {
      const next: Record<string, string[]> = {};
      for (const providerId of PROVIDER_IDS_WITH_CREDENTIALS) {
        try {
          const names = await providerCredentialsList(pid, providerId);
          next[providerId] = names;
        } catch {
          next[providerId] = [];
        }
      }
      setProviderKeys(next);
    } finally {
      setProviderKeysLoading(false);
    }
  }, [selectedProfileId]);

  useEffect(() => {
    fetchProviderKeys();
  }, [fetchProviderKeys]);

  /** Sync profile model draft from config when config or selected profile changes. */
  useEffect(() => {
    if (!config || typeof config !== "object" || !selectedProfileId) {
      setProfileModelIdDraft("");
      return;
    }
    const c = config as { profiles?: Array<{ id: string; root: string; modelId?: string }>; defaultModel?: string };
    const defaultModel = typeof c.defaultModel === "string" ? c.defaultModel : "";
    const list = c.profiles;
    if (!list?.length) {
      setProfileModelIdDraft(defaultModel);
      return;
    }
    const profile = list.find((p) => p.id === selectedProfileId);
    setProfileModelIdDraft(profile?.modelId ?? defaultModel);
  }, [config, selectedProfileId]);

  const handleRefreshModels = useCallback(async () => {
    if (!selectedProfileId) return;
    setModelListLoading(true);
    setModelListError(null);
    setFetchedModels([]);
    try {
      const result = await providerModelsList(selectedProfileId, modelListProviderId);
      if (result.error) {
        setModelListError(result.error.message || result.error.code || "Failed to list models");
        return;
      }
      setFetchedModels(result.models ?? []);
    } catch (e) {
      setModelListError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelListLoading(false);
    }
  }, [selectedProfileId, modelListProviderId]);

  const handleSaveProfileModel = useCallback(async () => {
    if (!config || typeof config !== "object" || !selectedProfileId) return;
    const c = config as { profiles?: Array<{ id: string; root: string; modelId?: string }> };
    const list = c.profiles;
    if (!list?.length) return;
    setProfileModelSaveBusy(true);
    setProfileModelSaveError(null);
    try {
      const updated = list.map((p) =>
        p.id === selectedProfileId ? { ...p, modelId: profileModelIdDraft.trim() || undefined } : p
      );
      await configPatch({ profiles: updated });
      await fetchConfig();
    } catch (e) {
      setProfileModelSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfileModelSaveBusy(false);
    }
  }, [config, selectedProfileId, profileModelIdDraft, fetchConfig]);

  const handleProviderKeySet = async (e: React.FormEvent) => {
    e.preventDefault();
    const keyName = providerKeyAddKeyName.trim();
    const value = providerKeyAddValue;
    const providerId = providerKeyAddProviderId;
    if (!keyName || !value || !selectedProfileId) return;
    setProviderKeySetBusy(true);
    setProviderKeySetError(null);
    try {
      await providerCredentialsSet(selectedProfileId, providerId, keyName, value);
      setProviderKeyAddValue("");
      await fetchProviderKeys();
    } catch (err) {
      setProviderKeySetError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderKeySetBusy(false);
    }
  };

  const handleProviderKeyDelete = async (providerId: string, keyName: string) => {
    if (!selectedProfileId) return;
    const key = `${providerId}:${keyName}`;
    setProviderKeyDeleteBusy(key);
    try {
      await providerCredentialsDelete(selectedProfileId, providerId, keyName);
      await fetchProviderKeys();
    } catch {
      // best-effort; list will refresh on next load
    } finally {
      setProviderKeyDeleteBusy(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = createId.trim();
    const root = createRoot.trim();
    if (!id || !root) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const { profile } = await profileCreate(id, root);
      await refreshProfiles();
      setSelectedProfileId(profile.id);
      setCreateId("");
      setCreateRoot("profiles/");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await profileDelete(deleteTarget.id, deleteTarget.removeDirectory);
      await refreshProfiles();
      if (deleteTarget.id === selectedProfileId) {
        setSelectedProfileId(defaultProfileId);
      }
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  const canDelete = () => profiles.length > 1;
  const isOnlyProfile = profiles.length === 1;

  const handleReload = async () => {
    setReloadBusy(true);
    setReloadError(null);
    try {
      await configReload();
      await fetchConfig();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloadBusy(false);
    }
  };

  const handleHeartbeatSave = async () => {
    if (heartbeatDraft == null) return;
    setHeartbeatPatchBusy(true);
    setHeartbeatPatchError(null);
    try {
      await configPatch({
        heartbeat: {
          enabled: heartbeatDraft.enabled,
          everyMs: heartbeatDraft.everyMs,
          minMs: heartbeatDraft.minMs,
          maxMs: heartbeatDraft.maxMs
        }
      });
      await fetchConfig();
    } catch (e) {
      setHeartbeatPatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setHeartbeatPatchBusy(false);
    }
  };

  const handleBindAddressSave = async () => {
    setBindAddressPatchBusy(true);
    setBindAddressPatchError(null);
    try {
      await configPatch({
        gateway: { bindAddress: bindAddressDraft.trim() }
      });
      await fetchConfig();
    } catch (e) {
      setBindAddressPatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setBindAddressPatchBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Config</h2>

      <div ref={profilesRef} id="profiles" className="config-section">
        <h3>Profiles</h3>
        <p className="muted">Create and delete agent profiles. Each profile has its own substrate, memory, heartbeat, and approvals.</p>

        <form onSubmit={handleCreate} className="form-inline" style={{ marginBottom: "1rem" }}>
          <label>
            Profile id
            <input
              type="text"
              value={createId}
              onChange={(e) => setCreateId(e.target.value)}
              placeholder="e.g. assistant"
              disabled={createBusy}
              required
            />
          </label>
          <label>
            Root (path under workspace)
            <input
              type="text"
              value={createRoot}
              onChange={(e) => setCreateRoot(e.target.value)}
              placeholder="profiles/assistant"
              disabled={createBusy}
              required
            />
          </label>
          <button type="submit" className="btn" disabled={createBusy}>
            {createBusy ? "Creating…" : "Create profile"}
          </button>
        </form>
        {createError && <p className="error-msg">{createError}</p>}

        <ul className="profile-list" style={{ listStyle: "none", padding: 0 }}>
          {profiles.map((p) => (
            <li key={p.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <span style={{ fontWeight: 500 }}>{p.id}</span>
              <span className="muted" style={{ fontSize: "0.9rem" }}>{p.root}</span>
              {canDelete() ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setDeleteTarget({ id: p.id, removeDirectory: false })}
                  disabled={!!deleteTarget}
                >
                  Delete
                </button>
              ) : isOnlyProfile ? (
                <span className="muted" style={{ fontSize: "0.85rem" }}>Cannot delete the only profile.</span>
              ) : null}
            </li>
          ))}
        </ul>
        {deleteError && <p className="error-msg">{deleteError}</p>}
      </div>

      {deleteTarget && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-profile-title">
          <div className="modal card">
            <h3 id="delete-profile-title">Delete profile &quot;{deleteTarget.id}&quot;?</h3>
            <p>This removes the profile from config. Data under its root is left unless you choose to remove it.</p>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={deleteTarget.removeDirectory}
                onChange={(e) => setDeleteTarget((t) => t ? { ...t, removeDirectory: e.target.checked } : null)}
              />
              Also remove the profile directory and its contents
            </label>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
              <button type="button" className="btn" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={handleDeleteConfirm} disabled={deleteBusy}>
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="config-section" style={{ marginTop: "1.5rem" }}>
        <h3>Config</h3>
        <p className="muted">
          Reload from disk to apply file changes without restart. Edit heartbeat below and Save to apply in memory and on disk. Secrets (token/password) are redacted in the raw view.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
          <button type="button" className="btn" onClick={handleReload} disabled={reloadBusy}>
            {reloadBusy ? "Reloading…" : "Reload from disk"}
          </button>
          {reloadError && <span className="error-msg">{reloadError}</span>}
        </div>

        {!loading ? (
          <div className="config-section" style={{ marginBottom: "1rem" }}>
            <h4>Gateway bind address (Tailscale)</h4>
            <p className="muted">
              Optional. Set to this host&apos;s Tailscale IP (e.g. <code>100.x.x.x</code>) so the server listens only on Tailnet. Use <code>tailscale ip -4</code> on the server. Restart required for changes to take effect; from another Tailscale device you can use Dashboard → Restart.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
              <label>
                Bind address
                <input
                  type="text"
                  value={bindAddressDraft}
                  onChange={(e) => setBindAddressDraft(e.target.value)}
                  placeholder="e.g. 100.64.1.1 or leave empty"
                  disabled={bindAddressPatchBusy}
                  style={{ width: "14rem", marginLeft: "0.25rem" }}
                />
              </label>
              <button type="button" className="btn" onClick={handleBindAddressSave} disabled={bindAddressPatchBusy}>
                {bindAddressPatchBusy ? "Saving…" : "Save"}
              </button>
              {bindAddressPatchError && <span className="error-msg">{bindAddressPatchError}</span>}
            </div>
          </div>
        ) : null}

        {!loading && selectedProfileId ? (
          <div className="config-section" style={{ marginBottom: "1rem" }}>
            <h4>Provider API keys</h4>
            <p className="muted">
              API keys for providers that use <code>apiKeyRef</code> (e.g. OpenAI-compatible). Stored per profile; values are never shown or logged. Use key name <code>apiKey</code> for the default key.
            </p>
            {providerKeysLoading ? (
              <p>Loading…</p>
            ) : (
              <>
                {PROVIDER_IDS_WITH_CREDENTIALS.map((providerId) => (
                  <div key={providerId} style={{ marginBottom: "1rem" }}>
                    <strong>{providerId}</strong>
                    <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0" }}>
                      {(providerKeys[providerId] ?? []).map((name) => (
                        <li key={name} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                          <code>{name}</code>
                          <span className="muted">••••••••</span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => handleProviderKeyDelete(providerId, name)}
                            disabled={providerKeyDeleteBusy !== null}
                            aria-label={`Delete ${name}`}
                          >
                            {providerKeyDeleteBusy === `${providerId}:${name}` ? "Deleting…" : "Delete"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <form onSubmit={handleProviderKeySet} className="form-inline" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "flex-end" }}>
                  <label>
                    Provider
                    <select
                      value={providerKeyAddProviderId}
                      onChange={(e) => setProviderKeyAddProviderId(e.target.value)}
                      disabled={providerKeySetBusy}
                      style={{ marginLeft: "0.25rem" }}
                    >
                      {PROVIDER_IDS_WITH_CREDENTIALS.map((id) => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Key name
                    <input
                      type="text"
                      value={providerKeyAddKeyName}
                      onChange={(e) => setProviderKeyAddKeyName(e.target.value)}
                      placeholder="apiKey"
                      disabled={providerKeySetBusy}
                      style={{ width: "6rem", marginLeft: "0.25rem" }}
                    />
                  </label>
                  <label>
                    Value
                    <input
                      type="password"
                      value={providerKeyAddValue}
                      onChange={(e) => setProviderKeyAddValue(e.target.value)}
                      placeholder="sk-…"
                      disabled={providerKeySetBusy}
                      autoComplete="off"
                      style={{ width: "14rem", marginLeft: "0.25rem" }}
                    />
                  </label>
                  <button type="submit" className="btn" disabled={providerKeySetBusy}>
                    {providerKeySetBusy ? "Saving…" : "Add / Update"}
                  </button>
                </form>
              </>
            )}
            {providerKeySetError && <p className="error-msg">{providerKeySetError}</p>}
          </div>
        ) : null}

        {!loading && selectedProfileId ? (
          <div className="config-section" style={{ marginBottom: "1rem" }}>
            <h4>Model selection</h4>
            <p className="muted">
              Choose which model this profile uses. Use &quot;Refresh from provider&quot; to load models from Ollama or an OpenAI-compatible API; then select one and Save. The value is stored as the profile&apos;s <code>modelId</code> (must exist in config <code>models</code> for that provider).
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
              <label>
                Current model
                <input
                  type="text"
                  value={profileModelIdDraft}
                  onChange={(e) => setProfileModelIdDraft(e.target.value)}
                  placeholder="e.g. default or model id"
                  disabled={profileModelSaveBusy}
                  style={{ width: "14rem", marginLeft: "0.25rem" }}
                />
              </label>
              <label>
                Provider
                <select
                  value={modelListProviderId}
                  onChange={(e) => setModelListProviderId(e.target.value)}
                  disabled={modelListLoading}
                  style={{ marginLeft: "0.25rem" }}
                >
                  {PROVIDER_IDS_WITH_MODEL_LIST.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn" onClick={handleRefreshModels} disabled={modelListLoading}>
                {modelListLoading ? "Loading…" : "Refresh from provider"}
              </button>
              {fetchedModels.length > 0 ? (
                <label>
                  Pick from list
                  <select
                    value={profileModelIdDraft}
                    onChange={(e) => setProfileModelIdDraft(e.target.value)}
                    disabled={profileModelSaveBusy}
                    style={{ marginLeft: "0.25rem", minWidth: "12rem" }}
                  >
                    <option value="">(use default)</option>
                    {fetchedModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button type="button" className="btn" onClick={handleSaveProfileModel} disabled={profileModelSaveBusy}>
                {profileModelSaveBusy ? "Saving…" : "Save"}
              </button>
            </div>
            {modelListError && <p className="error-msg">{modelListError}</p>}
            {profileModelSaveError && <p className="error-msg">{profileModelSaveError}</p>}
          </div>
        ) : null}

        {!loading && heartbeatDraft != null ? (
          <div className="config-section" style={{ marginBottom: "1rem" }}>
            <h4>Heartbeat (live)</h4>
            <p className="muted">Interval and limits apply on next tick without restart.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                <input
                  type="checkbox"
                  checked={heartbeatDraft.enabled ?? true}
                  onChange={(e) => setHeartbeatDraft((d) => ({ ...d, enabled: e.target.checked }))}
                />
                Enabled
              </label>
              <label>
                Interval (ms)
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={heartbeatDraft.everyMs ?? 30_000}
                  onChange={(e) => setHeartbeatDraft((d) => ({ ...d, everyMs: parseInt(e.target.value, 10) || 30_000 }))}
                />
              </label>
              <label>
                Min (ms)
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={heartbeatDraft.minMs ?? 300_000}
                  onChange={(e) => setHeartbeatDraft((d) => ({ ...d, minMs: parseInt(e.target.value, 10) || 300_000 }))}
                />
              </label>
              <label>
                Max (ms)
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={heartbeatDraft.maxMs ?? 3_600_000}
                  onChange={(e) => setHeartbeatDraft((d) => ({ ...d, maxMs: parseInt(e.target.value, 10) || 3_600_000 }))}
                />
              </label>
              <button type="button" className="btn" onClick={handleHeartbeatSave} disabled={heartbeatPatchBusy}>
                {heartbeatPatchBusy ? "Saving…" : "Save"}
              </button>
              {heartbeatPatchError && <span className="error-msg">{heartbeatPatchError}</span>}
            </div>
          </div>
        ) : null}

        <h4>Raw config (read-only)</h4>
        {loading && <p>Loading…</p>}
        {error && <p className="error-msg">{error}</p>}
        {!loading && !error && config !== null && config !== undefined ? (
          <>
            {Object.keys(config as Record<string, unknown>).map((key) => (
              <details key={key} style={{ marginTop: "0.5rem" }}>
                <summary>{key}</summary>
                <pre style={{ fontSize: "0.75rem", overflow: "auto", marginLeft: "1rem" }}>
                  {JSON.stringify((config as Record<string, unknown>)[key], null, 2)}
                </pre>
              </details>
            ))}
          </>
        ) : null}
        {!loading && !error && !config && <p>No config available.</p>}
      </div>
    </div>
  );
}
