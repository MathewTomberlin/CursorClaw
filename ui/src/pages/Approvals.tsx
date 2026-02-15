import { useEffect, useState } from "react";
import { rpc, mapRpcError } from "../api";

type Status = "pending" | "approved" | "denied" | "expired";

interface ApprovalRequest {
  id: string;
  createdAt: string;
  status: string;
  tool: string;
  intent: string;
  plan: string;
}

export default function Approvals() {
  const [statusFilter, setStatusFilter] = useState<Status | "">("pending");
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [grants, setGrants] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<ApprovalRequest | null>(null);
  const [resolveDecision, setResolveDecision] = useState<"approve" | "deny">("approve");
  const [resolveReason, setResolveReason] = useState("");
  const [resolveGrantTtlMs, setResolveGrantTtlMs] = useState("");
  const [resolveGrantUses, setResolveGrantUses] = useState("");
  const [resolveLoading, setResolveLoading] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const [listRes, capRes] = await Promise.all([
        rpc<{ requests: ApprovalRequest[] }>("approval.list", statusFilter ? { status: statusFilter } : undefined),
        rpc<{ grants: unknown[] }>("approval.capabilities")
      ]);
      setRequests(listRes.result?.requests ?? []);
      setGrants(capRes.result?.grants ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const openResolve = (r: ApprovalRequest) => {
    if (r.status !== "pending") return;
    setResolveTarget(r);
    setResolveDecision("approve");
    setResolveReason("");
    setResolveGrantTtlMs("");
    setResolveGrantUses("");
    setResolveError(null);
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    setResolveError(null);
    setResolveLoading(true);
    try {
      const params: { requestId: string; decision: "approve" | "deny"; reason?: string; grantTtlMs?: number; grantUses?: number } = {
        requestId: resolveTarget.id,
        decision: resolveDecision
      };
      if (resolveReason.trim()) params.reason = resolveReason.trim();
      const ttl = resolveGrantTtlMs.trim() ? Number.parseInt(resolveGrantTtlMs, 10) : undefined;
      if (ttl !== undefined && Number.isFinite(ttl) && ttl > 0) params.grantTtlMs = ttl;
      const uses = resolveGrantUses.trim() ? Number.parseInt(resolveGrantUses, 10) : undefined;
      if (uses !== undefined && Number.isFinite(uses) && uses > 0) params.grantUses = uses;
      await rpc("approval.resolve", params);
      setResolveTarget(null);
      await load();
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setResolveLoading(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Approvals</h2>
        <div className="form-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter((e.target.value || "") as Status | "")}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          Refresh
        </button>
        {error && <p className="error-msg">{error}</p>}
        {!loading && (
          <table style={{ width: "100%", marginTop: "1rem", fontSize: "0.875rem" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Created</th>
                <th>Tool</th>
                <th>Intent</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.id.slice(0, 8)}</td>
                  <td>{r.createdAt}</td>
                  <td>{r.tool}</td>
                  <td>{r.intent}</td>
                  <td>{r.status}</td>
                  <td>
                    {r.status === "pending" && (
                      <>
                        <button type="button" className="btn" onClick={() => { openResolve(r); setResolveDecision("approve"); }}>Approve</button>
                        {" "}
                        <button type="button" className="btn" onClick={() => { openResolve(r); setResolveDecision("deny"); }}>Deny</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {resolveTarget && (
        <div className="card" style={{ marginTop: "1rem", border: "2px solid var(--accent)" }}>
          <h2>Resolve request {resolveTarget.id.slice(0, 8)}</h2>
          <p>Confirm resolution. This action cannot be undone.</p>
          <div className="form-group">
            <label>Decision</label>
            <select value={resolveDecision} onChange={(e) => setResolveDecision(e.target.value as "approve" | "deny")}>
              <option value="approve">Approve</option>
              <option value="deny">Deny</option>
            </select>
          </div>
          <div className="form-group">
            <label>Reason (optional)</label>
            <input value={resolveReason} onChange={(e) => setResolveReason(e.target.value)} />
          </div>
          {resolveDecision === "approve" && (
            <>
              <div className="form-group">
                <label>Grant TTL (ms, optional)</label>
                <input type="number" value={resolveGrantTtlMs} onChange={(e) => setResolveGrantTtlMs(e.target.value)} placeholder="e.g. 600000" />
              </div>
              <div className="form-group">
                <label>Grant uses (optional)</label>
                <input type="number" value={resolveGrantUses} onChange={(e) => setResolveGrantUses(e.target.value)} placeholder="e.g. 1" />
              </div>
            </>
          )}
          {resolveError && <p className="error-msg">{resolveError}</p>}
          <button type="button" className="btn btn-primary" onClick={submitResolve} disabled={resolveLoading}>
            {resolveLoading ? "Submitting…" : "Submit"}
          </button>
          <button type="button" className="btn" onClick={() => setResolveTarget(null)} style={{ marginLeft: "0.5rem" }}>
            Cancel
          </button>
        </div>
      )}
      <div className="card">
        <h2>Active capabilities</h2>
        {grants.length === 0 ? <p>None</p> : <pre style={{ fontSize: "0.75rem" }}>{JSON.stringify(grants, null, 2)}</pre>}
      </div>
    </>
  );
}
