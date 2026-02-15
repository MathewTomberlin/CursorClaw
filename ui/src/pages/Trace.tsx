import { useState } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

export default function Trace() {
  const { selectedProfileId } = useProfile();
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("200");
  const [latencyMs, setLatencyMs] = useState("0");
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const ingest = async () => {
    const u = url.trim();
    if (!u) {
      setError("URL is required.");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const statusNum = Number.parseInt(status, 10) || 200;
      const latencyNum = Number.parseInt(latencyMs, 10) || 0;
      const params: { method: string; url: string; status: number; latencyMs: number; sessionId?: string } = {
        method,
        url: u,
        status: statusNum,
        latencyMs: latencyNum
      };
      if (sessionId.trim()) params.sessionId = sessionId.trim();
      const res = await rpcWithProfile("trace.ingest", params, selectedProfileId);
      setResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2>Trace ingest</h2>
      <div className="form-group">
        <label>Method</label>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>
      <div className="form-group">
        <label>URL (required)</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
      </div>
      <div className="form-group">
        <label>Status</label>
        <input type="number" value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Latency (ms)</label>
        <input type="number" value={latencyMs} onChange={(e) => setLatencyMs(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Session ID (optional)</label>
        <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
      </div>
      {error && <p className="error-msg">{error}</p>}
      <button type="button" className="btn btn-primary" onClick={ingest} disabled={loading}>
        {loading ? "Sending…" : "Ingest trace"}
      </button>
      {result != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}
