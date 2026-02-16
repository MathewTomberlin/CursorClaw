import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { rpc, mapRpcError, openStream, getThread, setThread } from "../api";
import { useProfile } from "./ProfileContext";

export type ChannelKind = "dm" | "group" | "web" | "mobile";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
}

/** Lifecycle event from /stream (queued, started, tool, assistant, compaction, completed, failed). */
export interface StreamEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  payload?: { call?: { name?: string }; content?: string; error?: string; reason?: string };
  at?: string;
}

const STORAGE_KEY_PREFIX = "cursorclaw_chat_";

/** Collapse consecutive assistant messages with identical trimmed content so the reply is only shown once. */
function dedupeConsecutiveAssistantReplies(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.role === "assistant" && (prev.content ?? "").trim() === (m.content ?? "").trim()) continue;
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

/** Max size for the messages array in the request body so we stay under gateway body limit and avoid 413. */
const MAX_MESSAGES_PAYLOAD_BYTES = 1.2 * 1024 * 1024; // 1.2 MiB (leaves room for session + JSON-RPC wrapper)

/**
 * Trim messages to fit within the request body limit. Keeps the most recent messages and, if any were dropped,
 * prepends a single user message so the model knows context was omitted.
 */
function trimMessagesToFit(
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  if (JSON.stringify(messages).length <= MAX_MESSAGES_PAYLOAD_BYTES) return messages;
  const omittedNotice: { role: string; content: string } = {
    role: "user",
    content: "[Previous messages omitted for length. Conversation continues with recent context below.]"
  };
  for (let n = messages.length; n > 0; n--) {
    const slice = messages.slice(-n);
    const withNotice = [omittedNotice, ...slice];
    if (JSON.stringify(withNotice).length <= MAX_MESSAGES_PAYLOAD_BYTES) return withNotice;
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
  currentRunId: string | null;
  loading: boolean;
  loadingStartedAt: number | null;
  error: string | null;
  setError: (e: string | null) => void;
  runTurn: (inputText: string) => Promise<void>;
  clearThread: () => void;
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
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  /** Only sync to server after we've loaded from server for this session/profile (avoids overwriting server with sessionStorage on first paint). */
  const serverLoadDoneRef = useRef(false);
  /** Prevents duplicate assistant messages from double-submit or racing agent.wait responses. */
  const runTurnInProgressRef = useRef(false);

  // Load thread from server when session or profile changes (shared message list for desktop and mobile)
  useEffect(() => {
    const sid = sessionId.trim();
    if (!sid || !selectedProfileId) return;
    serverLoadDoneRef.current = false;
    let cancelled = false;
    getThread(sid, selectedProfileId)
      .then(({ messages: serverMessages }) => {
        if (!cancelled && Array.isArray(serverMessages)) {
          const deduped = dedupeConsecutiveAssistantReplies(serverMessages);
          setMessages(deduped);
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

  // Keep lifecycle stream open for current session (survives tab switch)
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
        const data = JSON.parse(ev.data) as StreamEvent;
        setStreamEvents((prev) => [...prev, data]);
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
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
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
      setError(null);
      setCurrentRunId(null);
      setLoading(true);
      setLoadingStartedAt(Date.now());

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
        const trimmedMessages = trimMessagesToFit(apiMessages);

        const runRes = await rpc<{ runId: string }>("agent.run", {
          session: { sessionId: sessionId.trim(), channelId: channelId.trim(), channelKind, profileId: selectedProfileId },
          messages: trimmedMessages
        });
        const runId = runRes.result?.runId;
        if (!runId) throw new Error("No runId returned");
        setCurrentRunId(runId);

        // Poll agent.wait instead of one long-lived request to avoid browser/proxy timeouts ("Failed to fetch")
        const POLL_INTERVAL_MS = 2000;
        const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
        const startedAt = Date.now();
        let out: { status?: string; runId?: string; assistantText?: string; events?: unknown[] } | undefined;
        for (;;) {
          const waitRes = await rpc<{ status?: string; runId?: string; assistantText?: string; events?: unknown[] }>(
            "agent.wait",
            { runId }
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

        const assistantMsg: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: assistantText,
          at: new Date().toISOString()
        };
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && (last.content ?? "").trim() === (assistantText ?? "").trim()) {
            return prev;
          }
          return [...prev, assistantMsg];
        });
      } catch (e) {
        setError(
          e instanceof Error ? e.message : mapRpcError({ error: { code: "INTERNAL", message: String(e) } })
        );
        // Keep the user message so they see what they sent and the error
      } finally {
        setLoading(false);
        setLoadingStartedAt(null);
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
    currentRunId,
    loading,
    loadingStartedAt,
    error,
    setError,
    runTurn,
    clearThread
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
