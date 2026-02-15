/**
 * Server-side persistence of chat thread (message list) per profile and session.
 * Used so desktop and mobile (e.g. via Tailscale) see the same message list.
 * Thread files live under profile root tmp/threads/; sessionId is sanitized for path safety.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
}

const THREADS_DIR = "tmp";
const THREADS_SUBDIR = "threads";
const MAX_MESSAGES_PER_THREAD = 1000;
const SESSION_ID_MAX_LEN = 128;
const SAFE_SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizeSessionId(sessionId: string): string {
  const trimmed = String(sessionId).trim().slice(0, SESSION_ID_MAX_LEN);
  if (!trimmed) return "_empty";
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe || "_empty";
}

function threadPath(profileRoot: string, sessionId: string): string {
  const safe = sanitizeSessionId(sessionId);
  return join(profileRoot, THREADS_DIR, THREADS_SUBDIR, `${safe}.json`);
}

interface PersistedThread {
  messages: ThreadMessage[];
}

export async function getThread(profileRoot: string, sessionId: string): Promise<ThreadMessage[]> {
  const path = threadPath(profileRoot, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PersistedThread;
    const list = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return list.filter(
      (m): m is ThreadMessage =>
        m != null && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );
  } catch {
    return [];
  }
}

export async function setThread(
  profileRoot: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  const path = threadPath(profileRoot, sessionId);
  const now = new Date().toISOString();
  const threadMessages: ThreadMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_MESSAGES_PER_THREAD)
    .map((m) => ({
      id: randomUUID(),
      role: m.role as "user" | "assistant",
      content: String(m.content ?? ""),
      at: now
    }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ messages: threadMessages }, null, 2), "utf8");
}

export async function appendMessage(
  profileRoot: string,
  sessionId: string,
  message: { role: "user" | "assistant"; content: string }
): Promise<void> {
  const path = threadPath(profileRoot, sessionId);
  const now = new Date().toISOString();
  const threadMessages = await getThread(profileRoot, sessionId);
  const newMsg: ThreadMessage = {
    id: randomUUID(),
    role: message.role,
    content: String(message.content ?? ""),
    at: now
  };
  threadMessages.push(newMsg);
  const trimmed = threadMessages.slice(-MAX_MESSAGES_PER_THREAD);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ messages: trimmed }, null, 2), "utf8");
}

export { sanitizeSessionId };
