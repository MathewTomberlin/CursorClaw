import { useState, useEffect, useCallback } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

interface SubstrateKeyInfo {
  key: string;
  path: string;
  present: boolean;
}

const KEY_LABELS: Record<string, string> = {
  agents: "Workspace rules (AGENTS.md)",
  identity: "Identity (IDENTITY.md)",
  soul: "Soul (SOUL.md)",
  birth: "Birth (BIRTH.md)",
  capabilities: "Capabilities (CAPABILITIES.md)",
  user: "User (USER.md)",
  tools: "Tools (TOOLS.md)",
  roadmap: "Planning (ROADMAP.md)",
  studyGoals: "Study goals (STUDY_GOALS.md)"
};

export default function Substrate() {
  const { selectedProfileId } = useProfile();
  const [list, setList] = useState<SubstrateKeyInfo[]>([]);
  const [content, setContent] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const fetchList = useCallback(async () => {
    try {
      const res = await rpcWithProfile("substrate.list", undefined, selectedProfileId);
      const result = res.result as { keys: SubstrateKeyInfo[] };
      setList(result?.keys ?? []);
    } catch {
      setList([]);
    }
  }, [selectedProfileId]);

  const fetchContent = useCallback(async () => {
    try {
      const res = await rpcWithProfile("substrate.get", undefined, selectedProfileId);
      const result = (res.result ?? {}) as Record<string, string | undefined>;
      const next: Record<string, string> = {};
      for (const k of ["agents", "identity", "soul", "birth", "capabilities", "user", "tools", "roadmap", "studyGoals"]) {
        next[k] = result[k] ?? "";
      }
      setContent(next);
      setEdits({});
    } catch {
      setContent({});
    }
  }, [selectedProfileId]);

  useEffect(() => {
    (async () => {
      setError(null);
      setLoading(true);
      try {
        await fetchList();
        await fetchContent();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchList, fetchContent]);

  const handleEdit = (key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async (key: string) => {
    const value = key in edits ? edits[key] : content[key] ?? "";
    setSaving(key);
    setError(null);
    try {
      await rpcWithProfile("substrate.update", { key, content: value }, selectedProfileId);
      setContent((prev) => ({ ...prev, [key]: value }));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
    } finally {
      setSaving(null);
    }
  };

  const handleReloadFromDisk = async () => {
    setReloading(true);
    setError(null);
    try {
      await rpcWithProfile("substrate.reload", undefined, selectedProfileId);
      await fetchList();
      await fetchContent();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
    } finally {
      setReloading(false);
    }
  };

  if (loading) return <p>Loading…</p>;
  if (list.length === 0 && error)
    return (
      <div className="card">
        <p className="error-msg">{error}</p>
        <p>Substrate is only available when <code>substrate</code> is configured in openclaw.json.</p>
      </div>
    );

  return (
    <div className="card">
      <h2>Substrate (Identity &amp; Soul)</h2>
      <p className="warning-msg" style={{ marginBottom: "1rem" }}>
        Substrate files are included in the agent prompt. Do not put secrets or sensitive data here.
      </p>
      <p style={{ marginBottom: "1rem" }}>
        Edits take effect on the next agent turn without restart.
      </p>
      <button
        type="button"
        className="btn"
        onClick={handleReloadFromDisk}
        disabled={reloading}
        style={{ marginBottom: "1rem" }}
      >
        {reloading ? "Reloading…" : "Reload from disk"}
      </button>
      {error && <p className="error-msg">{error}</p>}
      {list.map(({ key, path, present }) => {
        const value = key in edits ? edits[key] : content[key] ?? "";
        const dirty = key in edits && edits[key] !== (content[key] ?? "");
        const label = KEY_LABELS[key] ?? `${key} (${path})`;
        return (
          <details key={key} open={present} style={{ marginTop: "0.75rem" }}>
            <summary>
              {label} {present ? "✓" : "(empty)"}
            </summary>
            <textarea
              value={value}
              onChange={(e) => handleEdit(key, e.target.value)}
              placeholder={`File not present. Add content and save to create ${path}.`}
              rows={8}
              style={{ width: "100%", fontFamily: "inherit", fontSize: "0.9rem", marginTop: "0.5rem" }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => handleSave(key)}
              disabled={saving === key || (present && !dirty)}
              style={{ marginTop: "0.25rem" }}
            >
              {saving === key ? "Saving…" : "Save"}
            </button>
          </details>
        );
      })}
    </div>
  );
}
