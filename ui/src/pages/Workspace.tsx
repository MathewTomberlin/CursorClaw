import { useState } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

export default function Workspace() {
  const { selectedProfileId } = useProfile();
  const [status, setStatus] = useState<unknown>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<unknown>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileChangeChannelId, setFileChangeChannelId] = useState("system");
  const [fileChangeFiles, setFileChangeFiles] = useState("");
  const [fileChangeEnqueue, setFileChangeEnqueue] = useState(true);
  const [fileChangeResult, setFileChangeResult] = useState<unknown>(null);
  const [fileChangeLoading, setFileChangeLoading] = useState(false);
  const [explainModulePath, setExplainModulePath] = useState("");
  const [explainSymbol, setExplainSymbol] = useState("");
  const [explainResult, setExplainResult] = useState<unknown>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  const loadStatus = async () => {
    setError(null);
    setStatusLoading(true);
    try {
      const res = await rpcWithProfile("workspace.status", undefined, selectedProfileId);
      setStatus(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setStatusLoading(false);
    }
  };

  const search = async () => {
    if (!query.trim()) {
      setError("Query is required.");
      return;
    }
    setError(null);
    setSearchLoading(true);
    try {
      const res = await rpcWithProfile("workspace.semantic_search", { query: query.trim() }, selectedProfileId);
      setSearchResults(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setSearchLoading(false);
    }
  };

  const fileChange = async () => {
    const files = fileChangeFiles.trim().split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) {
      setError("At least one file path is required.");
      return;
    }
    setError(null);
    setFileChangeLoading(true);
    setFileChangeResult(null);
    try {
      const res = await rpcWithProfile("advisor.file_change", {
        channelId: fileChangeChannelId.trim() || "system",
        files,
        enqueue: fileChangeEnqueue
      }, selectedProfileId);
      setFileChangeResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setFileChangeLoading(false);
    }
  };

  const explainFunction = async () => {
    const modulePath = explainModulePath.trim();
    const symbol = explainSymbol.trim();
    if (!modulePath || !symbol) {
      setError("Module path and symbol are required.");
      return;
    }
    setError(null);
    setExplainLoading(true);
    setExplainResult(null);
    try {
      const res = await rpcWithProfile("advisor.explain_function", { modulePath, symbol }, selectedProfileId);
      setExplainResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setExplainLoading(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Workspace status</h2>
        <button type="button" className="btn" onClick={loadStatus} disabled={statusLoading}>
          {statusLoading ? "Loading…" : "Load status"}
        </button>
        {status != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(status, null, 2)}</pre> : null}
      </div>
      <div className="card">
        <h2>Semantic search</h2>
        <div className="form-group">
          <label>Query</label>
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {error && <p className="error-msg">{error}</p>}
        <button type="button" className="btn btn-primary" onClick={search} disabled={searchLoading}>
          {searchLoading ? "Searching…" : "Search"}
        </button>
        {searchResults != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(searchResults, null, 2)}</pre> : null}
      </div>
      <div className="card">
        <h2>Advisor: file change</h2>
        <div className="form-group">
          <label>Channel ID</label>
          <input value={fileChangeChannelId} onChange={(e) => setFileChangeChannelId(e.target.value)} />
        </div>
        <div className="form-group">
          <label>File paths (one per line)</label>
          <textarea value={fileChangeFiles} onChange={(e) => setFileChangeFiles(e.target.value)} rows={3} placeholder="src/foo.ts&#10;src/bar.ts" />
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" checked={fileChangeEnqueue} onChange={(e) => setFileChangeEnqueue(e.target.checked)} /> Enqueue suggestions
          </label>
        </div>
        <button type="button" className="btn btn-primary" onClick={fileChange} disabled={fileChangeLoading}>
          {fileChangeLoading ? "Running…" : "Get suggestions"}
        </button>
        {fileChangeResult != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(fileChangeResult, null, 2)}</pre> : null}
      </div>
      <div className="card">
        <h2>Advisor: explain function</h2>
        <div className="form-group">
          <label>Module path</label>
          <input value={explainModulePath} onChange={(e) => setExplainModulePath(e.target.value)} placeholder="e.g. src/gateway.ts" />
        </div>
        <div className="form-group">
          <label>Symbol</label>
          <input value={explainSymbol} onChange={(e) => setExplainSymbol(e.target.value)} placeholder="e.g. buildGateway" />
        </div>
        <button type="button" className="btn btn-primary" onClick={explainFunction} disabled={explainLoading}>
          {explainLoading ? "Explaining…" : "Explain"}
        </button>
        {explainResult != null ? <pre style={{ fontSize: "0.75rem", marginTop: "1rem" }}>{JSON.stringify(explainResult, null, 2)}</pre> : null}
      </div>
    </>
  );
}
