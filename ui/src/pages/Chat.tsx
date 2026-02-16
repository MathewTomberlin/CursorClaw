import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rpc, mapRpcError, heartbeatPoll, isGatewayUnreachableError } from "../api";
import { useChat } from "../contexts/ChatContext";
import { useProfile } from "../contexts/ProfileContext";
import type { StreamEvent } from "../contexts/ChatContext";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const m = window.matchMedia(query);
    const handler = () => setMatches(m.matches);
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

/** Friendly label for a single stream event (last status only; overwrites as status changes). */
function formatStreamEventLabel(ev: StreamEvent): string {
  const toolName = ev.payload?.call?.name;
  switch (ev.type) {
    case "connecting":
      return "Connecting…";
    case "queued":
      return "In queue…";
    case "started":
      return "Starting…";
    case "streaming":
      return "Receiving reply…";
    case "thinking":
      return "Thinking…";
    case "tool":
      if (!toolName) return "Running tool…";
      // Prefer short, readable labels for common tools
      const friendly: Record<string, string> = {
        web_search: "Searching the web…",
        web_fetch: "Fetching page…",
        read_file: "Reading file…",
        write: "Writing file…",
        edit_notebook: "Editing notebook…",
        grep: "Searching codebase…",
        list_dir: "Listing files…",
        run_terminal_cmd: "Running command…",
        recall_memory: "Recalling memory…",
        remember_this: "Saving note…",
      };
      return friendly[toolName] ?? `Running ${toolName}…`;
    case "assistant":
      return "Writing reply…";
    case "compaction":
      return ev.payload?.reason ? `Compacting: ${ev.payload.reason}` : "Compacting context…";
    case "final_message_start":
      return "Writing reply…";
    case "completed":
      return "Completed";
    case "failed":
      return ev.payload?.error ? `Failed: ${ev.payload.error}` : "Failed";
    default:
      return ev.type || "Event";
  }
}

/** Isolated input so typing does not re-render the whole Chat page (fixes lag on phone/slow devices). */
function ChatInput({
  submitDisabled,
  onSubmit
}: {
  /** When true, user can still type but Enter and the Send button do not submit (e.g. while agent is processing). */
  submitDisabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const portraitMobile = useMediaQuery("(max-width: 640px) and (orientation: portrait)");
  const handleSubmit = () => {
    const text = value.trim();
    if (!text || submitDisabled) return;
    setValue("");
    onSubmit(text);
  };
  return (
    <div className="chat-input-row">
      <textarea
        className="chat-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Message the agent…"
        rows={portraitMobile ? 1 : 2}
        aria-label="Message the agent"
      />
      <button
        type="button"
        className="btn btn-primary chat-send-btn"
        onClick={() => handleSubmit()}
        disabled={submitDisabled || !value.trim()}
        title={submitDisabled ? "Waiting for agent…" : undefined}
      >
        {submitDisabled ? "Sending…" : "Send"}
      </button>
    </div>
  );
}

export default function Chat() {
  const { selectedProfileId, profiles } = useProfile();
  const {
    sessionId,
    setSessionId,
    channelId,
    setChannelId,
    channelKind,
    setChannelKind,
    messages,
    setMessages,
    loading,
    streamEvents,
    streamedContent,
    streamedThinkingContent,
    currentRunId,
    loadingStartedAt,
    error,
    reconnecting,
    retryConnection,
    runTurn: runTurnFromContext,
    clearThread,
    addPendingProactive
  } = useChat();

  /** Messages to render: when loading and we have streamed content, append a live assistant bubble so the message grows token-by-token (shown as soon as first token arrives, even before agent.run returns). */
  const displayMessages =
    loading && streamedContent
      ? [
          ...messages,
          {
            id: `streaming-${currentRunId ?? "pending"}`,
            role: "assistant" as const,
            content: stripThinkingTags(streamedContent),
            at: undefined
          }
        ]
      : messages;

  const [channelConfigOpen, setChannelConfigOpen] = useState(false);
  const [chatSendResult, setChatSendResult] = useState<string | null>(null);
  const [chatSendError, setChatSendError] = useState<string | null>(null);
  const [channelSendText, setChannelSendText] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [, setLoadingTick] = useState(0);
  /** Prevents overlapping heartbeat polls so we never process the same proactive message twice (e.g. from two in-flight requests). */
  const heartbeatPollInFlightRef = useRef(false);

  // While loading, tick every 500ms so "Working…" fallback can appear after delay
  useEffect(() => {
    if (!loading || loadingStartedAt == null) return;
    const interval = setInterval(() => setLoadingTick((n) => n + 1), 500);
    return () => clearInterval(interval);
  }, [loading, loadingStartedAt]);

  // Auto-scroll to bottom when new messages arrive (instant so tab switch doesn’t animate the whole log)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });
  }, [messages, streamEvents, streamedContent, streamedThinkingContent]);

  /** Normalize for dedupe: trim and collapse runs of whitespace so minor differences don't create duplicates. */
  function normalizeForDedupe(s: string): string {
    return (s ?? "").trim().replace(/\s+/g, " ");
  }

  /** Remove <think>/</think> and <thinking>...</thinking> from assistant text so they are never shown. */
  function stripThinkingTags(text: string): string {
    if (!text || text.length < 2) return text;
    let out = text;
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
    out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
    return out;
  }

  // Poll all profiles for proactive messages so both Cursor and Ollama (or other) agents' heartbeats are visible.
  // Selected profile: show in current thread. Other profiles: store and inject when user switches to that profile.
  useEffect(() => {
    const profileIds = profiles?.length ? profiles.map((p) => p.id) : ["default"];
    const poll = async () => {
      if (heartbeatPollInFlightRef.current) return;
      heartbeatPollInFlightRef.current = true;
      try {
        for (const profileId of profileIds) {
          const { proactiveMessage } = await heartbeatPoll(profileId);
          if (!proactiveMessage?.trim()) continue;
          const text = proactiveMessage.trim();
          if (profileId === selectedProfileId) {
            const normalized = normalizeForDedupe(text);
            setMessages((prev) => {
              const recent = prev.slice(-20);
              const lastAssistant = recent.length > 0 && recent[recent.length - 1]?.role === "assistant" ? recent[recent.length - 1] : null;
              const lastContent = (lastAssistant?.content ?? "").trim();
              const lastNormalized = normalizeForDedupe(lastContent);

              if (lastNormalized === normalized) return prev;
              if (recent.some((m) => m.role === "assistant" && normalizeForDedupe(m.content ?? "") === normalized)) return prev;

              if (lastAssistant && normalized.length > lastNormalized.length && normalized.startsWith(lastNormalized)) {
                const before = prev.slice(0, prev.length - 1);
                return [
                  ...before,
                  { ...lastAssistant, id: lastAssistant.id, content: text, at: new Date().toISOString() }
                ];
              }
              if (lastNormalized.length > normalized.length && lastNormalized.startsWith(normalized)) return prev;

              return [
                ...prev,
                {
                  id: `proactive-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  role: "assistant",
                  content: text,
                  at: new Date().toISOString()
                }
              ];
            });
          } else {
            addPendingProactive(profileId, text);
          }
        }
      } catch {
        // ignore poll errors (e.g. offline, auth)
      } finally {
        heartbeatPollInFlightRef.current = false;
      }
    };
    void poll();
    const intervalMs = 5_000;
    const t = setInterval(poll, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [selectedProfileId, profiles, setMessages, addPendingProactive]);

  const runTurn = (text: string) => {
    void runTurnFromContext(text);
  };

  // Events for the current run: filter by runId once we have it.
  // When we have currentRunId but no matching events yet, use recent events that belong to this run (or connecting).
  // If we still have no events (e.g. runId mismatch or stream just connected), use any recent stream events so status is never empty while loading.
  const eventsForRunId = currentRunId ? streamEvents.filter((e) => e.runId === currentRunId) : [];
  const recentStreamEvents = streamEvents.slice(-20);
  const recentForCurrentRun = currentRunId
    ? recentStreamEvents.filter((e) => !e.runId || e.runId === currentRunId)
    : recentStreamEvents;
  const runEvents = loading
    ? (() => {
        if (currentRunId) {
          if (eventsForRunId.length > 0) return eventsForRunId;
          if (recentForCurrentRun.length > 0) return recentForCurrentRun;
        }
        // Fallback: show latest stream activity so we never hide events (e.g. runId not yet set or format mismatch).
        return recentStreamEvents.length > 0 ? recentStreamEvents : [];
      })()
    : [];
  // Status types that overwrite each other in the UI (one line that updates in place).
  const STATUS_EVENT_TYPES = ["connecting", "queued", "started", "streaming", "tool", "thinking", "compaction", "final_message_start", "completed", "failed"];
  // Use the last *status* event for the label so we see "Queued" → "Starting" → "Streaming" → "Thinking" → "Running tool…" overwriting in place. If we used the last event overall, it would usually be "assistant" and we'd only see "Writing reply…" once.
  const lastStatusEvent = runEvents.filter((e) => STATUS_EVENT_TYPES.includes(e.type)).pop() ?? null;
  const lastStreamEvent = lastStatusEvent ?? (runEvents.length > 0 ? runEvents[runEvents.length - 1] : null);
  const hasRealProgress = runEvents.some(
    (e) =>
      e.type !== "connecting" && e.type !== "queued"
  );
  const loadingDurationMs = loadingStartedAt != null ? Date.now() - loadingStartedAt : 0;
  const showWorkingFallback =
    loading && loadingDurationMs > 1500 && !hasRealProgress && runEvents.length <= 2;

  // When we already have streamed content, show "Writing reply…". When we're past connecting (started/streaming) but no reply yet, show thinking phase so user sees "Thinking…" and the thinking block instead of only "Connecting…".
  const isPreReplyStreaming =
    loading &&
    !streamedContent &&
    (lastStreamEvent?.type === "streaming" || lastStreamEvent?.type === "started");
  const statusLabel =
    loading && streamedContent
      ? "Writing reply…"
      : isPreReplyStreaming
        ? "Thinking…"
        : lastStreamEvent
          ? formatStreamEventLabel(lastStreamEvent)
          : showWorkingFallback
            ? currentRunId
              ? "Connecting…"
              : "Starting run…"
            : loading
              ? currentRunId
                ? "Connecting…"
                : "Starting run…"
              : "Starting…";


  const sendToChannel = async () => {
    const text = channelSendText.trim();
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
            {displayMessages.length === 0 && !loading && (
              <div className="chat-empty">
                <p>No messages yet. Send a message to start a conversation with the agent.</p>
              </div>
            )}
            {displayMessages.map((msg) => {
              const isStreamingBubble = msg.role === "assistant" && msg.id.startsWith("streaming-");
              return (
                <div
                  key={msg.id}
                  className={`chat-bubble chat-bubble--${msg.role}${isStreamingBubble ? " chat-bubble--streaming" : ""}`}
                  data-role={msg.role}
                  aria-label={msg.role === "user" ? "You" : "Agent"}
                >
                  <span className="chat-bubble-role">{msg.role === "user" ? "You" : "Agent"}</span>
                  {msg.role === "assistant" ? (
                    <div className="chat-bubble-content markdown-body agent-reply">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripThinkingTags(msg.content ?? "") || "—"}</ReactMarkdown>
                      {isStreamingBubble && <span className="chat-streaming-cursor" aria-hidden />}
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
              );
            })}
            {loading && !streamedContent && (
              <div className="chat-bubble chat-bubble--assistant chat-bubble--loading" data-role="assistant">
                <span className="chat-bubble-role">Agent</span>
                <div className="chat-bubble-content">
                  {/* Show thinking block when: we have thinking content, we're in "thinking" status, or we're in "streaming" but no reply yet (so user sees thinking phase instead of only "Connecting…"). */}
                  {(lastStreamEvent?.type === "thinking" ||
                    streamedThinkingContent.length > 0 ||
                    isPreReplyStreaming) ? (
                    <div className="chat-thinking-block" role="status" aria-live="polite" aria-label="Agent thinking">
                      <span className="chat-thinking-label">Thinking:</span>
                      {streamedThinkingContent.length > 0 ? (
                        <pre className="chat-thinking-text">{streamedThinkingContent}</pre>
                      ) : (
                        <span className="chat-thinking-dots" aria-hidden>Thinking<span className="chat-thinking-dot">.</span><span className="chat-thinking-dot">.</span><span className="chat-thinking-dot">.</span></span>
                      )}
                    </div>
                  ) : (
                    <span className="chat-typing" role="status" aria-live="polite" aria-label={statusLabel}>
                      {statusLabel}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {reconnecting && (
            <p className="reconnecting-msg" style={{ marginTop: "0.5rem" }}>
              Reconnecting…
            </p>
          )}
          {error && (
            <p className="error-msg" style={{ marginTop: "0.5rem" }}>
              {error}
              {isGatewayUnreachableError(new Error(error)) && (
                <button
                  type="button"
                  className="btn"
                  style={{ marginLeft: "0.75rem" }}
                  onClick={() => retryConnection()}
                  disabled={reconnecting}
                >
                  Retry
                </button>
              )}
            </p>
          )}

          <ChatInput submitDisabled={loading} onSubmit={runTurn} />
        </section>
      </div>
    </div>
  );
}
