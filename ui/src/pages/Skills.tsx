import { useState, useEffect, useCallback } from "react";
import { mapRpcError, skillsList, skillsCredentialsSet, skillsCredentialsDelete, skillsCredentialsList, type InstalledSkillRecord } from "../api";
import { useProfile } from "../contexts/ProfileContext";

export default function Skills() {
  const { selectedProfileId } = useProfile();
  const [skills, setSkills] = useState<InstalledSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storedKeys, setStoredKeys] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<{ skillId: string; keyName: string } | null>(null);
  const [deleting, setDeleting] = useState<{ skillId: string; keyName: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});

  const loadSkills = useCallback(async () => {
    if (!selectedProfileId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await skillsList(selectedProfileId);
      setSkills(list);
      const keys: Record<string, string[]> = {};
      for (const s of list) {
        try {
          keys[s.id] = await skillsCredentialsList(selectedProfileId, s.id);
        } catch {
          keys[s.id] = [];
        }
      }
      setStoredKeys(keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [selectedProfileId]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const allKeyNames = (skill: InstalledSkillRecord): string[] => {
    const fromManifest = skill.credentialNames ?? [];
    const fromStore = storedKeys[skill.id] ?? [];
    const set = new Set([...fromManifest, ...fromStore]);
    return [...set].sort();
  };

  const handleSet = async (skillId: string, keyName: string) => {
    const value = drafts[skillId]?.[keyName] ?? "";
    if (!value.trim()) return;
    setSaving({ skillId, keyName });
    setError(null);
    try {
      await skillsCredentialsSet(selectedProfileId!, skillId, keyName, value.trim());
      setDrafts((d) => {
        const next = { ...d };
        if (next[skillId]) {
          next[skillId] = { ...next[skillId] };
          delete next[skillId][keyName];
        }
        return next;
      });
      setStoredKeys((k) => ({
        ...k,
        [skillId]: [...new Set([...(k[skillId] ?? []), keyName])]
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (skillId: string, keyName: string) => {
    setDeleting({ skillId, keyName });
    setError(null);
    try {
      await skillsCredentialsDelete(selectedProfileId!, skillId, keyName);
      setDrafts((d) => {
        const next = { ...d };
        if (next[skillId]) {
          next[skillId] = { ...next[skillId] };
          delete next[skillId][keyName];
        }
        return next;
      });
      setStoredKeys((k) => ({
        ...k,
        [skillId]: (k[skillId] ?? []).filter((n) => n !== keyName)
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setDeleting(null);
    }
  };

  const setDraft = (skillId: string, keyName: string, value: string) => {
    setDrafts((d) => ({
      ...d,
      [skillId]: { ...(d[skillId] ?? {}), [keyName]: value }
    }));
  };

  if (loading) {
    return (
      <div className="card">
        <h2>Skills</h2>
        <p className="muted">Loading installed skills…</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Skills</h2>
      <p className="muted">
        Installed skills and their credentials. Set API keys or secrets here; values are never shown or logged. The agent can ask you to add a key for a skill—use this page to set it.
      </p>
      {error && <p className="error-msg">{error}</p>}
      <div style={{ marginBottom: "1rem" }}>
        <button type="button" className="btn" onClick={loadSkills} disabled={loading}>
          Refresh
        </button>
      </div>
      {skills.length === 0 ? (
        <p className="muted">No installed skills for this profile. Install a skill via the agent or RPC <code>skills.install</code>.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {skills.map((skill) => (
            <li key={skill.id} className="config-section" style={{ marginBottom: "1.5rem" }}>
              <h3>{skill.id}</h3>
              <p className="muted" style={{ fontSize: "0.9rem" }}>
                {skill.sourceUrl} · installed {skill.installedAt ? new Date(skill.installedAt).toLocaleString() : ""}
              </p>
              {allKeyNames(skill).length === 0 ? (
                <p className="muted">No credentials defined for this skill.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0 }}>
                  {allKeyNames(skill).map((keyName) => (
                    <li key={keyName} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                      <code style={{ minWidth: "8rem" }}>{keyName}</code>
                      <input
                        type="password"
                        placeholder="••••••••"
                        value={drafts[skill.id]?.[keyName] ?? ""}
                        onChange={(e) => setDraft(skill.id, keyName, e.target.value)}
                        autoComplete="off"
                        style={{ width: "14rem" }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleSet(skill.id, keyName)}
                        disabled={saving !== null || !(drafts[skill.id]?.[keyName] ?? "").trim()}
                      >
                        {saving?.skillId === skill.id && saving?.keyName === keyName ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleDelete(skill.id, keyName)}
                        disabled={deleting !== null}
                      >
                        {deleting?.skillId === skill.id && deleting?.keyName === keyName ? "Deleting…" : "Delete"}
                      </button>
                      {(storedKeys[skill.id] ?? []).includes(keyName) && (
                        <span className="muted" style={{ fontSize: "0.85rem" }}>set</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
