import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { rpc, mapRpcError, openStream, getThread, setThread, isGatewayUnreachableError } from "../api";
import { useProfile } from "./ProfileContext";

export type ChannelKind = "dm" | "group" | "web" | "mobile";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
}

/** Lifecycle event from /stream (queued, started, streaming, tool, assistant, compaction, completed, failed). */
export interface StreamEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  payload?: {
    call?: { name?: string };
    content?: string;
    error?: string;
    reason?: string;
    /** When true, assistant content replaces the streamed buffer instead of appending. */
    replace?: boolean;
  };
  at?: string;
}

const STORAGE_KEY_PREFIX = "cursorclaw_chat_";

/** Normalize for dedupe: trim and collapse runs of whitespace so minor differences don't create duplicate bubbles. */
function normalizeForDedupe(s: string): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

/** Collapse consecutive assistant messages with identical trimmed content so the reply is only shown once. */
function dedupeConsecutiveAssistantReplies(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.role === "assistant" && normalizeForDedupe(prev.content ?? "") === normalizeForDedupe(m.content ?? ""))
      continue;
    out.push(m);
  }
  return out;
}

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

/** Stay under common gateway/proxy body limits (e.g. 512 KiB) so we avoid 413 regardless of server config. */
const MAX_RPC_BODY_BYTES = 400 * 1024; // 400 KiB for full JSON-RPC body (method + params)

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Trim messages so the full agent.run request body stays under MAX_RPC_BODY_BYTES. Uses UTF-8 byte length.
 * Keeps the most recent messages and, if any were dropped, prepends a user message so the model knows context was omitted.
 */
function trimMessagesToFit(
  session: { sessionId: string; channelId: string; channelKind: ChannelKind; profileId: string },
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  const payload = (msgs: Array<{ role: string; content: string }>) =>
    JSON.stringify({
      version: "2.0",
      method: "agent.run",
      params: { session, messages: msgs }
    });
  if (utf8ByteLength(payload(messages)) <= MAX_RPC_BODY_BYTES) return messages;
  const omittedNotice: { role: string; content: string } = {
    role: "user",
    content: "[Previous messages omitted for length. Conversation continues with recent context below.]"
  };
  for (let n = messages.length; n > 0; n--) {
    const slice = messages.slice(-n);
    const withNotice = [omittedNotice, ...slice];
    if (utf8ByteLength(payload(withNotice)) <= MAX_RPC_BODY_BYTES) return withNotice;
  }
  return [omittedNotice, ...messages.slice(-1)];
}

interface ChatContextValue {
  sessionId: string;
  setSessionId: (s: string) => void;
  channelId: string;
  setChannelId: (s: string) => void;
  channelKind: ChannelKind;
  setChannelKind: (k: ChannelKind) => void;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  streamEvents: StreamEvent[];
  /** Accumulated assistant content from stream for the current run (so UI can show live output). */
  streamedContent: string;
  /** Accumulated thinking content from stream for the current run (shown while loading). */
  streamedThinkingContent: string;
  currentRunId: string | null;
  loading: boolean;
  loadingStartedAt: number | null;
  error: string | null;
  setError: (e: string | null) => void;
  /** True while automatically retrying after reconnect (e.g. phone unlock); show "Reconnecting…" in UI. */
  reconnecting: boolean;
  /** Manually retry reaching the gateway and refetch thread (e.g. after "Cannot reach the gateway"). Preserves messages from sessionStorage. */
  retryConnection: () => void;
  runTurn: (inputText: string) => Promise<void>;
  clearThread: () => void;
  /** Store a proactive message for a profile that is not currently selected; injected when user switches to that profile. */
  addPendingProactive: (profileId: string, text: string) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

interface ChatProviderProps {
  children: ReactNode;
}

export function ChatProvider({ children }: ChatProviderProps) {
  const { selectedProfileId } = useProfile();
  const [sessionId, setSessionId] = useState("demo-session");
  const [channelId, setChannelId] = useState("dm:demo-session");
  const [channelKind, setChannelKind] = useState<ChannelKind>("dm");
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadThread("demo-session"));
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streamedContent, setStreamedContent] = useState("");
  const [streamedThinkingContent, setStreamedThinkingContent] = useState("");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  /** Increment to force the lifecycle stream to reopen (e.g. after phone unlock so dead SSE is replaced). */
  const [streamReconnectKey, setStreamReconnectKey] = useState(0);
  const streamRef = useRef<EventSource | null>(null);
  /** Only sync to server after we've loaded from server for this session/profile (avoids overwriting server with sessionStorage on first paint). */
  const serverLoadDoneRef = useRef(false);
  /** Prevents duplicate assistant messages from double-submit or racing agent.wait responses. */
  const runTurnInProgressRef = useRef(false);
  /** Run ID from server once agent.run returns; cleared in finally. Used to know when server has persisted the user message. */
  const currentRunIdRef = useRef<string | null>(null);
  /** AbortController for in-flight runTurn; aborted on timeout or unmount so loading is never stuck. */
  const runTurnAbortRef = useRef<AbortController | null>(null);
  /** Proactive messages received while that profile was not selected; injected when user switches to that profile. */
  const [pendingProactiveByProfile, setPendingProactiveByProfile] = useState<Record<string, string[]>>({});
  const pendingProactiveRef = useRef<Record<string, string[]>>({});
  const selectedProfileIdRef = useRef(selectedProfileId);
  selectedProfileIdRef.current = selectedProfileId;
  pendingProactiveRef.current = pendingProactiveByProfile;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;

  const addPendingProactive = useCallback((profileId: string, text: string) => {
    setPendingProactiveByProfile((prev) => ({
      ...prev,
      [profileId]: [...(prev[profileId] ?? []), text]
    }));
  }, []);

  // Load thread from server when session or profile changes (shared message list for desktop and mobile)
  // When a run is in progress but server hasn't confirmed yet (no runId), merge server + optimistic tail so we don't lose the just-sent user message when switching profile/view.
  useEffect(() => {
    const sid = sessionId.trim();
    if (!sid || !selectedProfileId) return;
    serverLoadDoneRef.current = false;
    let cancelled = false;
    const profileIdForLoad = selectedProfileId;
    getThread(sid, selectedProfileId)
      .then(({ messages: serverMessages }) => {
        if (!cancelled && Array.isArray(serverMessages)) {
          const deduped = dedupeConsecutiveAssistantReplies(serverMessages);
          const pending = pendingProactiveRef.current[profileIdForLoad] ?? [];
          let toSet: ChatMessage[] =
            pending.length > 0 && selectedProfileIdRef.current === profileIdForLoad
              ? [
                  ...deduped,
                  ...pending.map((content) => ({
                    id: generateId(),
                    role: "assistant" as const,
                    content,
                    at: new Date().toISOString()
                  }))
                ]
              : deduped;
          const stillForCurrentProfile =
            sessionIdRef.current === sid && selectedProfileIdRef.current === profileIdForLoad;
          if (!stillForCurrentProfile) {
            // Load was for a different session/profile; don't overwrite current view
          } else if (
            currentRunIdRef.current === null &&
            runTurnInProgressRef.current
          ) {
            // Preserve optimistic user message when runTurn sent but agent.run not returned yet.
            // Never overwrite with empty server state here—React may not have applied the optimistic update yet.
            if (toSet.length > 0) {
              setMessages((local) => {
                if (local.length <= toSet.length) return toSet;
                const tail = local.slice(toSet.length);
                const hasUser = tail.some((m) => m.role === "user");
                if (hasUser) return [...toSet, ...tail];
                return toSet;
              });
            }
          } else {
            setMessages(toSet);
          }
          if (pending.length > 0 && selectedProfileIdRef.current === profileIdForLoad) {
            setPendingProactiveByProfile((prev) => {
              const next = { ...prev };
              delete next[profileIdForLoad];
              return next;
            });
          }
        }
        if (!cancelled) serverLoadDoneRef.current = true;
      })
      .catch(() => {
        if (!cancelled) setMessages(loadThread(sid));
        if (!cancelled) serverLoadDoneRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedProfileId]);

  // Persist thread when messages change: sessionStorage (backup) and server (shared view for desktop/Tailscale)
  useEffect(() => {
    const sid = sessionId.trim();
    if (!sid) return;
    saveThread(sid, messages);
    if (selectedProfileId && serverLoadDoneRef.current) {
      setThread(sid, selectedProfileId, messages).catch(() => {
        // Offline or server unavailable; sessionStorage already updated
      });
    }
  }, [messages, sessionId, selectedProfileId]);

  // Shared retry logic: refetch thread and reopen stream after reconnect. Preserve messages from sessionStorage.
  const RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAYS_MS = [800, 1600, 3200, 5000, 8000]; // exponential backoff
  const runReconnectRetry = useCallback(() => {
    const sid = sessionIdRef.current?.trim();
    const pid = selectedProfileIdRef.current;
    if (!sid || !pid) return;
    setReconnecting(true);
    setStreamReconnectKey((k) => k + 1); // reopen EventSource so dead SSE after lock is replaced
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];
    const tryGetThread = (attempt: number) => {
      getThread(sid, pid)
        .then(({ messages: serverMessages }) => {
          if (!Array.isArray(serverMessages)) return;
          const deduped = dedupeConsecutiveAssistantReplies(serverMessages);
          setMessages((prev) => {
            if (deduped.length === 0 && prev.length > 0) return prev;
            if (prev.length > deduped.length) return prev;
            return deduped;
          });
          const currentError = errorRef.current;
          if (currentError && isGatewayUnreachableError(new Error(currentError))) {
            setError(null);
          }
          setReconnecting(false);
        })
        .catch(() => {
          if (attempt < RECONNECT_ATTEMPTS) {
            const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 3000;
            const id = setTimeout(() => tryGetThread(attempt + 1), delay);
            timeoutIds.push(id);
          } else {
            setReconnecting(false);
          }
        });
    };
    tryGetThread(0);
    return () => timeoutIds.forEach((id) => clearTimeout(id));
  }, []);

  const reconnectCleanupRef = useRef<(() => void) | null>(null);

  // When page becomes visible again (e.g. phone unlock) or browser goes online, retry so we recover
  // from "Cannot reach the gateway" and messages are refetched without manual refresh.
  useEffect(() => {
    let scheduleTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const onVisibleOrOnline = () => {
      if (document.visibilityState !== "visible") return;
      const sid = sessionIdRef.current?.trim();
      const pid = selectedProfileIdRef.current;
      if (!sid || !pid) return;
      reconnectCleanupRef.current?.();
      scheduleTimeoutId = setTimeout(() => {
        scheduleTimeoutId = null;
        reconnectCleanupRef.current = runReconnectRetry() ?? null;
      }, 400);
    };
    document.addEventListener("visibilitychange", onVisibleOrOnline);
    window.addEventListener("online", onVisibleOrOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibleOrOnline);
      window.removeEventListener("online", onVisibleOrOnline);
      if (scheduleTimeoutId != null) clearTimeout(scheduleTimeoutId);
      reconnectCleanupRef.current?.();
    };
  }, [runReconnectRetry]);

  // Safety net: clear loading if it has been stuck for too long (e.g. server hung without closing connection)
  const LOADING_MAX_MS = 11 * 60 * 1000; // 11 min
  useEffect(() => {
    if (!loading || loadingStartedAt == null) return;
    const interval = setInterval(() => {
      if (loadingStartedAt != null && Date.now() - loadingStartedAt > LOADING_MAX_MS) {
        setLoading(false);
        setLoadingStartedAt(null);
        setCurrentRunId(null);
        currentRunIdRef.current = null;
        runTurnInProgressRef.current = false;
        setError("Send timed out. You can try again.");
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [loading, loadingStartedAt]);

  // Keep lifecycle stream open for current session. Reopens when streamReconnectKey changes (e.g. after phone unlock).
  useEffect(() => {
    const sid = sessionId.trim();
    if (!sid) return;
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    const es = openStream(sid);
    streamRef.current = es;
    es.onmessage = (ev) => {
      try {
        // Support single JSON or newline-delimited JSON in one message (so only the latest status is ever kept).
        const raw = String(ev.data ?? "").trim();
        if (!raw) return;
        const lines = raw.includes("\n") ? raw.split(/\n/).map((s) => s.trim()).filter(Boolean) : [raw];
        const payloads: StreamEvent[] = [];
        for (const line of lines) {
          try {
            payloads.push(JSON.parse(line) as StreamEvent);
          } catch {
            // skip malformed line
          }
        }
        if (payloads.length === 0) return;
        for (const data of payloads) {
          // Streaming status updates overwrite each other: only one status event is kept (the latest). Assistant chunks replace the last assistant.
          setStreamEvents((prev) => {
            const isFinalAssistant =
              data.type === "assistant" && (data.payload as { replace?: boolean } | undefined)?.replace === true;
            const last = prev[prev.length - 1];
            const statusTypes = ["connecting", "queued", "started", "streaming", "tool", "thinking", "compaction", "final_message_start", "completed", "failed"];
            let next: StreamEvent[];
            // Assistant: replace last assistant with this one unless it's the final (replace: true) message.
            if (data.type === "assistant") {
              if (!isFinalAssistant && last?.type === "assistant") next = [...prev.slice(0, -1), data];
              else next = [...prev, data];
            } else if (statusTypes.includes(data.type)) {
              // Status types: remove ALL status events from the array (not just trailing), then append this one so only the latest status is shown.
              const rest = prev.filter((e) => !statusTypes.includes(e.type));
              next = [...rest, data];
            } else {
              next = [...prev, data];
            }
            return next.length > 100 ? next.slice(-100) : next;
          });
          // Only skip content for a different run when event has a non-empty runId (so we still process thinking/assistant if runId is missing)
          const runIdMismatch =
            currentRunIdRef.current != null &&
            data.runId != null &&
            data.runId !== "" &&
            data.runId !== currentRunIdRef.current;
          if (runIdMismatch) continue;
          if (data.type === "assistant") {
            const payload = data.payload as { content?: string; replace?: boolean } | undefined;
            const next = payload?.content ?? "";
            // Backend sends accumulated content during final-message phase; overwrite so the message grows in place.
            setStreamedContent(next);
          } else if (data.type === "thinking") {
            const payload = data.payload as { content?: string } | undefined;
            const content = payload?.content ?? "";
            // Replace only: each chunk clears the previous thinking display (no accumulation).
            setStreamedThinkingContent(content);
          } else if (data.type === "final_message_start") {
            setStreamedThinkingContent("");
          } else if (data.type === "completed" || data.type === "failed") {
            setStreamedThinkingContent("");
            setStreamedContent("");
          }
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      es.close();
      streamRef.current = null;
    };
    return () => {
      es.close();
      if (streamRef.current === es) streamRef.current = null;
    };
  }, [sessionId, streamReconnectKey]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      runTurnAbortRef.current?.abort();
    };
  }, []);

  const runTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId.trim() || !channelId.trim()) {
        setError("Session ID, channel ID, and message are required.");
        return;
      }
      if (runTurnInProgressRef.current) return;
      runTurnInProgressRef.current = true;
      currentRunIdRef.current = null;
      setError(null);
      setCurrentRunId(null);
      // Do not clear streamEvents here: server may push "queued"/"started" before agent.run returns;
      // keeping them lets status show as soon as events arrive (filtered by runId in the UI).
      setStreamedContent("");
      setStreamedThinkingContent("");
      setLoading(true);
      setLoadingStartedAt(Date.now());

      const abort = new AbortController();
      runTurnAbortRef.current = abort;
      const RUN_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min total
      const timeoutId = setTimeout(() => abort.abort(), RUN_TURN_TIMEOUT_MS);

      const userMsg: ChatMessage = {
        id: generateId(),
        role: "user",
        content: trimmed,
        at: new Date().toISOString()
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const messageHistory = [...messages, userMsg];
        const apiMessages = messageHistory
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content }));
        const session = {
          sessionId: sessionId.trim(),
          channelId: channelId.trim(),
          channelKind,
          profileId: selectedProfileId
        };
        const trimmedMessages = trimMessagesToFit(session, apiMessages);

        const runRes = await rpc<{ runId: string }>(
          "agent.run",
          { session, messages: trimmedMessages },
          { signal: abort.signal }
        );
        const runId = runRes.result?.runId;
        if (!runId) throw new Error("No runId returned");
        currentRunIdRef.current = runId;
        setCurrentRunId(runId);

        // Sync from server so thread is source of truth (avoids lost messages when switching profile/view).
        // Only replace when server has at least as many messages; otherwise we'd wipe the optimistic user message.
        const sid = sessionId.trim();
        const pid = selectedProfileId;
        getThread(sid, pid)
          .then(({ messages: serverMessages }) => {
            if (sessionIdRef.current !== sid || selectedProfileIdRef.current !== pid || !Array.isArray(serverMessages)) return;
            setMessages((prev) => {
              const deduped = dedupeConsecutiveAssistantReplies(serverMessages);
              // Never replace with empty when we have local messages (optimistic user message may not be on server yet).
              if (deduped.length === 0 && prev.length > 0) return prev;
              if (prev.length > deduped.length) return prev;
              return deduped;
            });
          })
          .catch(() => {});

        // Poll agent.wait instead of one long-lived request to avoid browser/proxy timeouts ("Failed to fetch")
        const POLL_INTERVAL_MS = 2000;
        const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
        const startedAt = Date.now();
        let out: { status?: string; runId?: string; assistantText?: string; events?: unknown[] } | undefined;
        for (;;) {
          const waitRes = await rpc<{ status?: string; runId?: string; assistantText?: string; events?: unknown[] }>(
            "agent.wait",
            { runId },
            { signal: abort.signal }
          );
          out = waitRes.result;
          if (out && (out as { status?: string }).status === "pending") {
            if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new Error("Turn timed out. Please try again.");
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            continue;
          }
          break;
        }
        const assistantText = out?.assistantText ?? "";

        setStreamedContent("");
        setStreamedThinkingContent("");
        const assistantMsg: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: assistantText,
          at: new Date().toISOString()
        };
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const isStreamingBubble =
            last?.role === "assistant" &&
            typeof last.id === "string" &&
            last.id.startsWith("streaming-");
          const base = isStreamingBubble ? prev.slice(0, prev.length - 1) : prev;
          const effectiveLast = base[base.length - 1];
          if (effectiveLast?.role !== "assistant")
            return [...base, assistantMsg];
          const lastNorm = normalizeForDedupe(effectiveLast.content ?? "");
          const newNorm = normalizeForDedupe(assistantText);
          if (lastNorm === newNorm) return base.length < prev.length ? base : prev;
          if (newNorm.length > lastNorm.length && newNorm.startsWith(lastNorm)) {
            return [
              ...base.slice(0, base.length - 1),
              { ...effectiveLast, content: assistantText, at: assistantMsg.at }
            ];
          }
          if (lastNorm.length > newNorm.length && lastNorm.startsWith(newNorm))
            return base.length < prev.length ? base : prev;
          return [...base, assistantMsg];
        });
      } catch (e) {
        const msg =
          e instanceof Error && e.name === "AbortError"
            ? "Request was cancelled or timed out. You can send again."
            : e instanceof Error
              ? e.message
              : mapRpcError({ error: { code: "INTERNAL", message: String(e) } });
        setError(msg);
        // Keep the user message so they see what they sent and the error
      } finally {
        clearTimeout(timeoutId);
        runTurnAbortRef.current = null;
        setLoading(false);
        setLoadingStartedAt(null);
        setStreamedContent("");
        setStreamedThinkingContent("");
        currentRunIdRef.current = null;
        setCurrentRunId(null);
        runTurnInProgressRef.current = false;
      }
    },
    [sessionId, channelId, channelKind, messages, selectedProfileId]
  );

  const clearThread = useCallback(() => {
    setMessages([]);
    const sid = sessionId.trim();
    if (sid) {
      try {
        sessionStorage.removeItem(STORAGE_KEY_PREFIX + sid);
      } catch {
        // ignore
      }
      if (selectedProfileId) {
        setThread(sid, selectedProfileId, []).catch(() => {});
      }
    }
  }, [sessionId, selectedProfileId]);

  const value: ChatContextValue = {
    sessionId,
    setSessionId,
    channelId,
    setChannelId,
    channelKind,
    setChannelKind,
    messages,
    setMessages,
    streamEvents,
    streamedContent,
    streamedThinkingContent,
    currentRunId,
    loading,
    loadingStartedAt,
    error,
    setError,
    reconnecting,
    retryConnection: runReconnectRetry,
    runTurn,
    clearThread,
    addPendingProactive
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
