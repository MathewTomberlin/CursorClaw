import { useState, useEffect, useCallback } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

export default function Heartbeat() {
  const { selectedProfileId } = useProfile();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchContent = useCallback(async () => {
    try {
      const res = await rpcWithProfile<{ content: string }>("heartbeat.getFile", undefined, selectedProfileId);
      const payload = res.result;
      const text = payload != null && typeof payload === "object" && typeof (payload as { content?: string }).content === "string"
        ? (payload as { content: string }).content
        : "";
      setContent(text);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
    } finally {
      setLoading(false);
    }
  }, [selectedProfileId]);

  useEffect(() => {
    void fetchContent();
  }, [fetchContent]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await rpcWithProfile("heartbeat.update", { content }, selectedProfileId);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div className="card">
      <h2>HEARTBEAT.md</h2>
      <p style={{ marginBottom: "1rem" }}>
        Per-tick checklist for the agent. The server reads this file on each heartbeat run. If the agent has
        something to say (e.g. a task here or BIRTH), it will reply with a message instead of{" "}
        <code>HEARTBEAT_OK</code> and that message is delivered as a <strong>proactive message</strong> in the
        Chat tab.
      </p>
      <p style={{ marginBottom: "1rem" }}>
        Edits here take effect on the <strong>next heartbeat</strong> (no restart). To test proactive messages,
        add a line like: &quot;Say hello to the user in the web Chat.&quot;
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Add checklist items or instructions for the next heartbeat…"
        rows={14}
        style={{ width: "100%", fontFamily: "inherit", fontSize: "0.9rem", marginBottom: "0.75rem" }}
      />
      <button type="button" className="btn" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save (use on next heartbeat)"}
      </button>
      {error && <p className="error-msg" style={{ marginTop: "0.75rem" }}>{error}</p>}
    </div>
  );
}
