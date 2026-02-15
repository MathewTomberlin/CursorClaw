import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rpc, mapRpcError } from "../api";
import { useChat } from "../contexts/ChatContext";
import type { StreamEvent } from "../contexts/ChatContext";

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

export default function Chat() {
  const {
    sessionId,
    setSessionId,
    channelId,
    setChannelId,
    channelKind,
    setChannelKind,
    messages,
    loading,
    streamEvents,
    currentRunId,
    loadingStartedAt,
    error,
    runTurn: runTurnFromContext,
    clearThread
  } = useChat();

  const [input, setInput] = useState("");
  const [channelConfigOpen, setChannelConfigOpen] = useState(false);
  const [chatSendResult, setChatSendResult] = useState<string | null>(null);
  const [chatSendError, setChatSendError] = useState<string | null>(null);
  const [channelSendText, setChannelSendText] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [, setLoadingTick] = useState(0);

  // While loading, tick every 500ms so "Working…" fallback can appear after delay
  useEffect(() => {
    if (!loading || loadingStartedAt == null) return;
    const interval = setInterval(() => setLoadingTick((n) => n + 1), 500);
    return () => clearInterval(interval);
  }, [loading, loadingStartedAt]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamEvents]);

  const runTurn = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await runTurnFromContext(text);
  };

  // Events for the current run: filter by runId once we have it, else show recent events so "Queued" can appear before runId
  const runEvents = loading
    ? currentRunId
      ? streamEvents.filter((e) => e.runId === currentRunId)
      : streamEvents.slice(-20)
    : [];
  const lastStreamEvent = runEvents.length > 0 ? runEvents[runEvents.length - 1] : null;
  const statusTrail = runEvents.map(formatStreamEventLabel);
  const hasRealProgress = runEvents.some(
    (e) => e.type !== "connecting" && e.type !== "queued"
  );
  const loadingDurationMs = loadingStartedAt != null ? Date.now() - loadingStartedAt : 0;
  const showWorkingFallback =
    loading && loadingDurationMs > 1500 && !hasRealProgress && statusTrail.length <= 2;

  const statusLabel = lastStreamEvent
    ? formatStreamEventLabel(lastStreamEvent)
    : showWorkingFallback
      ? currentRunId
        ? "Working… (waiting for stream)"
        : "Working… (starting run)"
      : loading
        ? currentRunId
          ? "Waiting for events…"
          : "Starting run…"
        : "Starting…";


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
                {channelConfigOpen ? "Hide" : "Conversation settings"}
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
                <select value={channelKind} onChange={(e) => setChannelKind(e.target.value as "dm" | "group" | "web" | "mobile")}>
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
                  <span className="chat-typing" aria-live="polite">
                    {statusLabel}
                  </span>
                  {statusTrail.length > 0 && (
                    <div
                      className="chat-status-trail"
                      aria-label={`Agent status: ${statusTrail.join(" → ")}`}
                      role="status"
                    >
                      <span className="chat-status-trail-label">Status:</span>
                      {statusTrail.map((label, i) => (
                        <span
                          key={i}
                          className={
                            runEvents[i]?.type === "tool"
                              ? "chat-status-event chat-status-event--tool"
                              : "chat-status-event"
                          }
                          data-current={i === statusTrail.length - 1 ? "true" : undefined}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
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
