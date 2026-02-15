import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { setAuth, getBaseUrl, clearAuth } from "../api";

export default function Login() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState(getBaseUrl() || (typeof window !== "undefined" ? window.location.origin : ""));
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const url = baseUrl.trim().replace(/\/$/, "") || (typeof window !== "undefined" ? window.location.origin : "");
    const t = token.trim();
    if (!t) {
      setError("Token is required.");
      return;
    }
    setLoading(true);
    try {
      setAuth(url, t);
      const res = await fetch(`${url}/status`, {
        headers: { Authorization: `Bearer ${t}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError("Invalid or expired token.");
        } else {
          setError("Connection failed.");
        }
        clearAuth();
        return;
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
      clearAuth();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page card">
      <h1>CursorClaw</h1>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="baseUrl">Gateway URL</label>
          <input
            id="baseUrl"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://127.0.0.1:8787"
            autoComplete="url"
          />
        </div>
        <div className="form-group">
          <label htmlFor="token">Auth token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token from openclaw.json"
            autoComplete="off"
          />
        </div>
        {error && <p className="error-msg">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
