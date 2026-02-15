import { useState } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

export default function Incidents() {
  const { selectedProfileId } = useProfile();
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const trigger = async () => {
    if (confirm !== "CONFIRM") {
      setError("Type CONFIRM to proceed.");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await rpcWithProfile("incident.bundle", undefined, selectedProfileId);
      setResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2>Incident containment</h2>
      <p>This will disable proactive sends and enable tool isolation. Admin only.</p>
      <div className="form-group">
        <label>Type CONFIRM to proceed</label>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="CONFIRM" />
      </div>
      {error && <p className="error-msg">{error}</p>}
      <button type="button" className="btn btn-primary" onClick={trigger} disabled={loading || confirm !== "CONFIRM"}>
        {loading ? "Triggering…" : "Trigger incident"}
      </button>
      {result != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}
