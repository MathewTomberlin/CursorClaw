import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { rpc, mapRpcError, profileCreate, profileDelete } from "../api";
import { useProfile } from "../contexts/ProfileContext";

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

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        const res = await rpc("config.get");
        setConfig(res.result);
      } catch (e) {
        setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (location.hash === "#profiles" && profilesRef.current) {
      profilesRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [location.hash]);

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
        <h3>Config (read-only)</h3>
        <p className="muted">Secrets (token/password) are redacted. Changes require editing openclaw.json and restart.</p>
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
