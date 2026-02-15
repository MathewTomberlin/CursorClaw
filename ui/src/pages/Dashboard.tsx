import { useEffect, useState } from "react";
import { getHealth, getStatus, mapRpcError, restartFramework, type StatusPayload } from "../api";

export default function Dashboard() {
  const [health, setHealth] = useState<{ ok: boolean; time: string } | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [h, s] = await Promise.all([getHealth(), getStatus()]);
        if (!cancelled) {
          setHealth(h);
          setStatus(s);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error-msg">{error}</p>;

  return (
    <>
      <div className="card">
        <h2>Health</h2>
        {health && (
          <div className="metrics-grid">
            <div className="metric">
              <span>Status</span>
              <strong>{health.ok ? "OK" : "Error"}</strong>
            </div>
            <div className="metric">
              <span>Time</span>
              <strong>{health.time}</strong>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Status</h2>
        {status && (
          <>
            <div className="metrics-grid">
              <div className="metric">
                <span>Gateway</span>
                <strong>{status.gateway}</strong>
              </div>
              <div className="metric">
                <span>Default model</span>
                <strong>{status.defaultModel}</strong>
              </div>
              <div className="metric">
                <span>Scheduler backlog</span>
                <strong>{status.schedulerBacklog}</strong>
              </div>
              <div className="metric">
                <span>Pending approvals</span>
                <strong>{status.approvals.pending}</strong>
              </div>
              <div className="metric">
                <span>Active capabilities</span>
                <strong>{status.approvals.activeCapabilities}</strong>
              </div>
            </div>
            <div className="metrics-grid">
              <div className="metric">
                <span>Turns started</span>
                <strong>{status.runtimeMetrics.turnsStarted}</strong>
              </div>
              <div className="metric">
                <span>Turns completed</span>
                <strong>{status.runtimeMetrics.turnsCompleted}</strong>
              </div>
              <div className="metric">
                <span>Turns failed</span>
                <strong>{status.runtimeMetrics.turnsFailed}</strong>
              </div>
              <div className="metric">
                <span>Tool calls</span>
                <strong>{status.runtimeMetrics.toolCalls}</strong>
              </div>
            </div>
            {status.adapterMetrics?.lastFallbackError && (
              <div className="card" style={{ marginTop: "1rem", borderColor: "var(--error)", background: "rgba(248,81,73,0.08)" }}>
                <h2>Cursor-Agent CLI fallback</h2>
                <p>The primary model (e.g. cursor-auto) failed; the fallback model was used for the last turn.</p>
                <p style={{ fontFamily: "monospace", fontSize: "0.875rem", marginTop: "0.5rem" }}>{String(status.adapterMetrics.lastFallbackError)}</p>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  Check that the CLI is on PATH (or set <code>command</code> to the full path in openclaw.json), that it accepts the adapter contract (see docs/cursor-agent-adapter.md), and that it emits a <code>done</code> event.
                </p>
              </div>
            )}
            {status.queueWarnings.length > 0 && (
              <div className="metric">
                <span>Queue warnings</span>
                <ul>
                  {status.queueWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="metrics-grid">
              <div className="metric">
                <span>Proactive sends</span>
                <strong>{status.incident.proactiveSendsDisabled ? "Disabled" : "Enabled"}</strong>
              </div>
              <div className="metric">
                <span>Tool isolation</span>
                <strong>{status.incident.toolIsolationEnabled ? "On" : "Off"}</strong>
              </div>
            </div>
            <div className="metric" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={restarting}
                onClick={async () => {
                  setRestartError(null);
                  setRestarting(true);
                  try {
                    await restartFramework();
                    setRestartError(null);
                  } catch (e) {
                    setRestartError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
                  } finally {
                    setRestarting(false);
                  }
                }}
              >
                {restarting ? "Restarting…" : "Restart framework"}
              </button>
              {restarting && (
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  Building, then restarting. This page will disconnect.
                </p>
              )}
              {!restarting && (
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  Run <code>npm run start:watch</code> so restart keeps the process in the same terminal.
                </p>
              )}
              {restartError && <p className="error-msg" style={{ marginTop: "0.5rem" }}>{restartError}</p>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
