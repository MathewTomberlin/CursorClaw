import { useState, useRef, useEffect } from "react";
import { rpc, mapRpcError } from "../api";

type ChannelKind = "dm" | "group" | "web" | "mobile";

export default function Chat() {
  const [sessionId, setSessionId] = useState("demo-session");
  const [channelId, setChannelId] = useState("dm:demo-session");
  const [channelKind, setChannelKind] = useState<ChannelKind>("dm");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [events, setEvents] = useState<unknown[]>([]);
  const [streamEvents, setStreamEvents] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatSendResult, setChatSendResult] = useState<string | null>(null);
  const [chatSendError, setChatSendError] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  const runTurn = async () => {
    const text = message.trim();
    if (!text || !sessionId.trim() || !channelId.trim()) {
      setError("Session ID, channel ID, and message are required.");
      return;
    }
    setError(null);
    setReply("");
    setEvents([]);
    setStreamEvents([]);
    setLoading(true);
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    try {
      const runRes = await rpc<{ runId: string }>("agent.run", {
        session: { sessionId: sessionId.trim(), channelId: channelId.trim(), channelKind },
        messages: [{ role: "user", content: text }]
      });
      const runId = runRes.result?.runId;
      if (!runId) throw new Error("No runId returned");
      try {
        const { openStream } = await import("../api");
        const es = openStream(sessionId.trim());
        streamRef.current = es;
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            setStreamEvents((prev) => [...prev, data]);
            if (data.type === "completed" || data.type === "failed") {
              es.close();
              streamRef.current = null;
            }
          } catch {
            // ignore
          }
        };
        es.onerror = () => {
          es.close();
          streamRef.current = null;
        };
      } catch {
        // Stream optional; ignore
      }
      const waitRes = await rpc<{ assistantText: string; events?: unknown[] }>("agent.wait", { runId });
      const out = waitRes.result;
      if (out) {
        setReply(out.assistantText ?? "");
        if (Array.isArray(out.events)) setEvents(out.events);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    } finally {
      setLoading(false);
    }
  };

  const sendChat = async () => {
    const text = message.trim();
    if (!text || !channelId.trim()) {
      setChatSendError("Channel ID and text are required.");
      return;
    }
    setChatSendError(null);
    setChatSendResult(null);
    try {
      const res = await rpc<{ delivered?: boolean; reason?: string }>("chat.send", {
        channelId: channelId.trim(),
        text
      });
      const r = res.result;
      setChatSendResult(r?.delivered === true ? "Delivered." : r?.reason ? `Not delivered: ${r.reason}` : "Sent.");
    } catch (e) {
      setChatSendError(e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } }));
    }
  };

  return (
    <div className="card">
      <h2>Agent</h2>
      <div className="form-group">
        <label>Session ID</label>
        <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Channel ID</label>
        <input value={channelId} onChange={(e) => setChannelId(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Channel kind</label>
        <select value={channelKind} onChange={(e) => setChannelKind(e.target.value as ChannelKind)}>
          <option value="dm">dm</option>
          <option value="group">group</option>
          <option value="web">web</option>
          <option value="mobile">mobile</option>
        </select>
      </div>
      <div className="form-group">
        <label>Message</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
      </div>
      {error && <p className="error-msg">{error}</p>}
      <button type="button" className="btn btn-primary" onClick={runTurn} disabled={loading}>
        {loading ? "Running…" : "Send"}
      </button>
      {streamEvents.length > 0 && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2>Live events</h2>
          <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: "8rem" }}>{JSON.stringify(streamEvents, null, 2)}</pre>
        </div>
      )}
      {reply && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2>Reply</h2>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{reply}</pre>
          {events.length > 0 && (
            <details style={{ marginTop: "0.75rem" }}>
              <summary>Events ({events.length})</summary>
              <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: "12rem" }}>{JSON.stringify(events, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      <div className="card" style={{ marginTop: "1.5rem" }}>
        <h2>Send to channel (chat.send)</h2>
        <p>Uses the channel ID above. Sends the message in the input above.</p>
        <button type="button" className="btn btn-primary" onClick={sendChat} disabled={loading}>
          Send to channel
        </button>
        {chatSendResult && <p style={{ color: "var(--success)", marginTop: "0.5rem" }}>{chatSendResult}</p>}
        {chatSendError && <p className="error-msg">{chatSendError}</p>}
      </div>
    </div>
  );
}
