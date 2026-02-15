import { useState, useEffect, useCallback } from "react";
import { rpcWithProfile, mapRpcError } from "../api";
import { useProfile } from "../contexts/ProfileContext";

interface LogFile {
  name: string;
  path: string;
}

export default function Memory() {
  const { selectedProfileId } = useProfile();
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [memorySaving, setMemorySaving] = useState(false);

  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [logFilesLoading, setLogFilesLoading] = useState(true);
  const [selectedLogPath, setSelectedLogPath] = useState<string | null>(null);
  const [logContent, setLogContent] = useState("");
  const [logDirty, setLogDirty] = useState(false);
  const [logSaving, setLogSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const loadMemoryFile = useCallback(async () => {
    setError(null);
    try {
      const res = await rpcWithProfile("memory.getFile", { path: "MEMORY.md" }, selectedProfileId);
      const result = res.result as { path: string; content: string } | undefined;
      setMemoryContent(result?.content ?? "");
      setMemoryDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      setMemoryContent("");
    } finally {
      setMemoryLoading(false);
    }
  }, [selectedProfileId]);

  const loadLogList = useCallback(async () => {
    setError(null);
    try {
      const res = await rpcWithProfile("memory.listLogs", undefined, selectedProfileId);
      const result = res.result as { files: LogFile[] } | undefined;
      setLogFiles(result?.files ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      setLogFiles([]);
    } finally {
      setLogFilesLoading(false);
    }
  }, [selectedProfileId]);

  const loadLogFile = useCallback(async (path: string) => {
    setSelectedLogPath(path);
    setError(null);
    setLogDirty(false);
    try {
      const res = await rpcWithProfile("memory.getFile", { path }, selectedProfileId);
      const result = res.result as { path: string; content: string } | undefined;
      setLogContent(result?.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
      setLogContent("");
    }
  }, [selectedProfileId]);

  useEffect(() => {
    loadMemoryFile();
  }, [loadMemoryFile]);

  useEffect(() => {
    loadLogList();
  }, [loadLogList]);

  const saveMemory = async () => {
    setMemorySaving(true);
    setError(null);
    try {
      await rpcWithProfile("memory.writeFile", { path: "MEMORY.md", content: memoryContent }, selectedProfileId);
      setMemoryDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setMemorySaving(false);
    }
  };

  const saveLog = async () => {
    if (!selectedLogPath) return;
    setLogSaving(true);
    setError(null);
    try {
      await rpcWithProfile("memory.writeFile", { path: selectedLogPath, content: logContent }, selectedProfileId);
      setLogDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLogSaving(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Long-term memory (MEMORY.md)</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: "1rem" }}>
          Curated memories the agent reads at session start. Edits here affect what the agent remembers.
        </p>
        {error && <p className="error-msg">{error}</p>}
        {memoryLoading ? (
          <p>Loading…</p>
        ) : (
          <>
            <textarea
              value={memoryContent}
              onChange={(e) => {
                setMemoryContent(e.target.value);
                setMemoryDirty(true);
              }}
              placeholder="MEMORY.md is empty. Add notes the agent should remember."
              rows={12}
              style={{ width: "100%", fontFamily: "inherit", fontSize: "0.9rem", marginBottom: "0.5rem" }}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveMemory}
              disabled={memorySaving || !memoryDirty}
            >
              {memorySaving ? "Saving…" : "Save MEMORY.md"}
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Daily logs (memory/*.md)</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: "1rem" }}>
          Raw daily logs the agent writes. Select a file to view or edit.
        </p>
        <div style={{ display: "flex", gap: "1rem", minHeight: 0, flex: 1 }}>
          <div style={{ flex: "0 0 14rem", display: "flex", flexDirection: "column" }}>
            <label className="form-group" style={{ marginBottom: "0.25rem" }}>
              Log files
            </label>
            {logFilesLoading ? (
              <p>Loading…</p>
            ) : logFiles.length === 0 ? (
              <p style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>No daily logs yet.</p>
            ) : (
              <ul
                className="memory-log-list"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  overflowY: "auto",
                  maxHeight: "20rem",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  background: "var(--bg)"
                }}
              >
                {logFiles.map(({ name, path }) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="btn"
                      style={{
                        width: "100%",
                        textAlign: "left",
                        borderRadius: 0,
                        borderBottom: "1px solid var(--border)",
                        background: selectedLogPath === path ? "rgba(88, 166, 255, 0.15)" : "transparent"
                      }}
                      onClick={() => loadLogFile(path)}
                    >
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {selectedLogPath ? (
              <>
                <label className="form-group" style={{ marginBottom: "0.25rem" }}>
                  {selectedLogPath}
                </label>
                <textarea
                  value={logContent}
                  onChange={(e) => {
                    setLogContent(e.target.value);
                    setLogDirty(true);
                  }}
                  placeholder="Log content"
                  rows={14}
                  style={{
                    width: "100%",
                    fontFamily: "inherit",
                    fontSize: "0.9rem",
                    marginBottom: "0.5rem",
                    flex: 1,
                    minHeight: "12rem"
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={saveLog}
                  disabled={logSaving || !logDirty}
                >
                  {logSaving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                Select a log file from the list to view or edit.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
