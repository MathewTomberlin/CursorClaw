import { useState, useEffect } from "react";
import { rpc, mapRpcError } from "../api";

export default function Config() {
  const [config, setConfig] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error-msg">{error}</p>;
  if (!config) return <p>No config available.</p>;
  const c = config as Record<string, unknown>;
  return (
    <div className="card">
      <h2>Config (read-only)</h2>
      <p>Secrets (token/password) are redacted. Changes require editing openclaw.json and restart.</p>
      {Object.keys(c).map((key) => (
        <details key={key} style={{ marginTop: "0.5rem" }}>
          <summary>{key}</summary>
          <pre style={{ fontSize: "0.75rem", overflow: "auto", marginLeft: "1rem" }}>{JSON.stringify(c[key], null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
