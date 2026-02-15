import { useState, useEffect } from "react";
import { rpc, mapRpcError } from "../api";

interface CronJob {
  id: string;
  type: string;
  expression: string;
  isolated: boolean;
  maxRetries: number;
  backoffMs: number;
  nextRunAt?: number;
}

export default function Cron() {
  const [type, setType] = useState<"at" | "every" | "cron">("every");
  const [expression, setExpression] = useState("30m");
  const [isolated, setIsolated] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const loadJobs = async () => {
    setListLoading(true);
    try {
      const res = await rpc<{ jobs: CronJob[] }>("cron.list");
      setJobs(res.result?.jobs ?? []);
    } catch {
      setJobs([]);
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, []);

  const addJob = async () => {
    setError(null);
    setSuccess(false);
    setLoading(true);
    try {
      await rpc("cron.add", { type, expression, isolated });
      setSuccess(true);
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Add job</h2>
        <div className="form-group">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as "at" | "every" | "cron")}>
            <option value="every">every</option>
            <option value="at">at</option>
            <option value="cron">cron</option>
          </select>
        </div>
        <div className="form-group">
          <label>Expression</label>
          <input value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="e.g. 30m" />
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} /> Isolated
          </label>
        </div>
        {error && <p className="error-msg">{error}</p>}
        {success && <p style={{ color: "var(--success)" }}>Job added.</p>}
        <button type="button" className="btn btn-primary" onClick={addJob} disabled={loading}>
          {loading ? "Adding…" : "Add job"}
        </button>
      </div>
      <div className="card">
        <h2>Jobs</h2>
        <button type="button" className="btn" onClick={loadJobs} disabled={listLoading}>
          Refresh
        </button>
        {listLoading ? (
          <p>Loading…</p>
        ) : (
          <table style={{ width: "100%", marginTop: "1rem", fontSize: "0.875rem" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Expression</th>
                <th>Isolated</th>
                <th>Next run</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.id.slice(0, 8)}</td>
                  <td>{j.type}</td>
                  <td>{j.expression}</td>
                  <td>{j.isolated ? "Yes" : "No"}</td>
                  <td>{j.nextRunAt != null ? new Date(j.nextRunAt).toISOString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!listLoading && jobs.length === 0 && <p>No jobs.</p>}
      </div>
    </>
  );
}
