import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rpc, mapRpcError, openStream } from "../api";

type ChannelKind = "dm" | "group" | "web" | "mobile";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
}

/** Lifecycle event from /stream (queued, started, tool, assistant, compaction, completed, failed). */
interface StreamEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  payload?: { call?: { name?: string }; content?: string; error?: string; reason?: string };
  at?: string;
}

function formatStreamEventLabel(ev: StreamEvent): string {
  switch (ev.type) {
    case "connecting":
      return "Connecting…";
    case "queued":
      return "Queued";
    case "started":
      return "Started";
    case "tool":
      return ev.payload?.call?.name ? `Tool: ${ev.payload.call.name}` : "Tool call";
    case "assistant":
      return "Writing reply…";
    case "compaction":
      return ev.payload?.reason ? `Compacting: ${ev.payload.reason}` : "Compacting context…";
    case "completed":
      return "Completed";
    case "failed":
      return ev.payload?.error ? `Failed: ${ev.payload.error}` : "Failed";
    default:
      return ev.type || "Event";
  }
}

const STORAGE_KEY_PREFIX = "cursorclaw_chat_";

function loadThread(sessionId: string): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_PREFIX + sessionId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveThread(sessionId: string, messages: ChatMessage[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(messages));
  } catch {
    // ignore
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function Chat() {
  const [sessionId, setSessionId] = useState("demo-session");
  const [channelId, setChannelId] = useState("dm:demo-session");
  const [channelKind, setChannelKind] = useState<ChannelKind>("dm");
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadThread("demo-session"));
  const [input, setInput] = useState("");
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channelConfigOpen, setChannelConfigOpen] = useState(false);
  const [chatSendResult, setChatSendResult] = useState<string | null>(null);
  const [chatSendError, setChatSendError] = useState<string | null>(null);
  const [channelSendText, setChannelSendText] = useState("");
  const streamRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Persist thread when session or messages change
  useEffect(() => {
    if (sessionId.trim()) saveThread(sessionId.trim(), messages);
  }, [sessionId, messages]);

  // Load thread when session changes
  useEffect(() => {
    const sid = sessionId.trim();
    if (sid) setMessages(loadThread(sid));
  }, [sessionId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamEvents]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  const runTurn = async () => {
    const text = input.trim();
    if (!text || !sessionId.trim() || !channelId.trim()) {
      setError("Session ID, channel ID, and message are required.");
      return;
    }
    setError(null);
    setStreamEvents([]);
    setLoading(true);
    setInput("");

    const userMsg: ChatMessage = {
      id: generateId(),
      role: "user",
      content: text,
      at: new Date().toISOString()
    };
    setMessages((prev) => [...prev, userMsg]);

    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    try {
      try {
        const es = openStream(sessionId.trim());
        streamRef.current = es;
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as StreamEvent;
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

      const messageHistory = [...messages, userMsg];
      const apiMessages = messageHistory
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      const runRes = await rpc<{ runId: string }>("agent.run", {
        session: { sessionId: sessionId.trim(), channelId: channelId.trim(), channelKind },
        messages: apiMessages
      });
      const runId = runRes.result?.runId;
      if (!runId) throw new Error("No runId returned");
      const waitRes = await rpc<{ assistantText: string; events?: unknown[] }>("agent.wait", { runId });
      const out = waitRes.result;
      const assistantText = out?.assistantText ?? "";

      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: "assistant",
        content: assistantText,
        at: new Date().toISOString()
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
    } finally {
      setLoading(false);
    }
  };

  const lastStreamEvent = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
  const statusLabel = lastStreamEvent ? formatStreamEventLabel(lastStreamEvent) : "Starting…";

  const sendToChannel = async () => {
    const text = (channelSendText || input).trim();
    if (!text || !channelId.trim()) {
      setChatSendError("Channel ID and message text are required.");
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
      setChatSendResult(
        r?.delivered === true ? "Delivered to channel." : r?.reason ? `Not delivered: ${r.reason}` : "Sent."
      );
      if (r?.delivered) setChannelSendText("");
    } catch (e) {
      setChatSendError(
        e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
      );
    }
  };

  const clearThread = () => {
    setMessages([]);
    if (sessionId.trim()) {
      try {
        sessionStorage.removeItem(STORAGE_KEY_PREFIX + sessionId.trim());
      } catch {
        // ignore
      }
    }
  };

  return (
    <div className="chat-page">
      <div className="chat-layout">
        <section className="chat-thread-card card">
          <div className="chat-thread-header">
            <h2>Chat with agent</h2>
            <div className="chat-thread-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setChannelConfigOpen((o) => !o)}
                aria-expanded={channelConfigOpen}
              >
                {channelConfigOpen ? "Hide" : "Session & channels"}
              </button>
              <button type="button" className="btn" onClick={clearThread} disabled={loading}>
                Clear thread
              </button>
            </div>
          </div>

          {channelConfigOpen && (
            <div className="chat-channel-config card" style={{ marginTop: "0.75rem" }}>
              <h3 style={{ marginTop: 0, fontSize: "0.9375rem" }}>Session & channel</h3>
              <p className="chat-config-desc">
                Session and channel identify this conversation. Use <strong>Send to channel</strong> below to
                deliver a message to the configured channel (e.g. Slack or local echo) without running the
                agent.
              </p>
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
                <label>Send to channel (chat.send)</label>
                <input
                  value={channelSendText}
                  onChange={(e) => setChannelSendText(e.target.value)}
                  placeholder="Message to deliver to channel…"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={sendToChannel}
                  disabled={loading}
                  style={{ marginTop: "0.5rem" }}
                >
                  Send to channel
                </button>
                {chatSendResult && (
                  <p style={{ color: "var(--success)", marginTop: "0.5rem", fontSize: "0.875rem" }}>
                    {chatSendResult}
                  </p>
                )}
                {chatSendError && <p className="error-msg">{chatSendError}</p>}
              </div>
            </div>
          )}

          <div className="chat-messages" ref={scrollRef} role="log" aria-live="polite">
            {messages.length === 0 && !loading && (
              <div className="chat-empty">
                <p>No messages yet. Send a message to start a conversation with the agent.</p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-bubble chat-bubble--${msg.role}`}
                data-role={msg.role}
                aria-label={msg.role === "user" ? "You" : "Agent"}
              >
                <span className="chat-bubble-role">{msg.role === "user" ? "You" : "Agent"}</span>
                {msg.role === "assistant" ? (
                  <div className="chat-bubble-content markdown-body agent-reply">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content || "—"}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="chat-bubble-content chat-bubble-content--text">{msg.content}</div>
                )}
                {msg.at && (
                  <span className="chat-bubble-time" aria-hidden>
                    {new Date(msg.at).toLocaleTimeString()}
                  </span>
                )}
              </div>
            ))}
            {loading && (
              <div className="chat-bubble chat-bubble--assistant chat-bubble--loading" data-role="assistant">
                <span className="chat-bubble-role">Agent</span>
                <div className="chat-bubble-content">
                  <span className="chat-typing">{statusLabel}</span>
                </div>
              </div>
            )}
          </div>

          {error && <p className="error-msg" style={{ marginTop: "0.5rem" }}>{error}</p>}

          <div className="chat-input-row">
            <textarea
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runTurn();
                }
              }}
              placeholder="Message the agent…"
              rows={2}
              disabled={loading}
              aria-label="Message the agent"
            />
            <button
              type="button"
              className="btn btn-primary chat-send-btn"
              onClick={() => void runTurn()}
              disabled={loading || !input.trim()}
            >
              {loading ? "Sending…" : "Send"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
