import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILENAME = "recent-topics.json";
const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_TOPIC_MAX_CHARS = 100;
const DEFAULT_LOAD_MAX_ENTRIES = 10;
const DEFAULT_LOAD_MAX_CHARS = 800;

export interface RecentTopicEntry {
  sessionId: string;
  topic: string;
  at: string;
}

export interface RecentTopicsStore {
  entries: RecentTopicEntry[];
}

function storePath(profileRoot: string): string {
  return join(profileRoot, "tmp", FILENAME);
}

async function ensureTmp(profileRoot: string): Promise<void> {
  await mkdir(join(profileRoot, "tmp"), { recursive: true });
}

async function loadStore(profileRoot: string): Promise<RecentTopicsStore> {
  const path = storePath(profileRoot);
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as RecentTopicsStore;
    if (Array.isArray(data?.entries)) return data;
  } catch {
    // missing or invalid
  }
  return { entries: [] };
}

async function saveStore(profileRoot: string, store: RecentTopicsStore): Promise<void> {
  await ensureTmp(profileRoot);
  await writeFile(storePath(profileRoot), JSON.stringify(store, null, 0), "utf8");
}

/**
 * Append or update a topic for this session. Topic is trimmed and capped to 100 chars.
 * Keeps last maxEntries (default 10). If sessionId already exists, that entry is updated in place.
 */
export async function appendTopic(
  profileRoot: string,
  sessionId: string,
  topic: string,
  options?: { maxEntries?: number; topicMaxChars?: number }
): Promise<void> {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const topicMaxChars = options?.topicMaxChars ?? DEFAULT_TOPIC_MAX_CHARS;
  const trimmed = topic.slice(0, topicMaxChars).trim();
  if (!trimmed) return;

  const store = await loadStore(profileRoot);
  const at = new Date().toISOString();
  const existingIdx = store.entries.findIndex((e) => e.sessionId === sessionId);
  if (existingIdx >= 0) {
    store.entries[existingIdx] = { sessionId, topic: trimmed, at };
  } else {
    store.entries.push({ sessionId, topic: trimmed, at });
  }
  // Keep last N by most recent
  store.entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  store.entries = store.entries.slice(0, maxEntries);
  await saveStore(profileRoot, store);
}

/**
 * Load recent topics as a formatted string for prompt injection, or undefined if empty.
 * Caps total characters and number of entries.
 */
export async function loadRecentTopicsContext(
  profileRoot: string,
  options?: { maxEntries?: number; maxChars?: number }
): Promise<string | undefined> {
  const maxEntries = options?.maxEntries ?? DEFAULT_LOAD_MAX_ENTRIES;
  const maxChars = options?.maxChars ?? DEFAULT_LOAD_MAX_CHARS;
  const store = await loadStore(profileRoot);
  const entries = store.entries.slice(0, maxEntries);
  if (entries.length === 0) return undefined;

  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < entries.length && total < maxChars; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const line = `${i + 1}. ${entry.topic}`;
    if (total + line.length + 1 > maxChars) {
      lines.push(line.slice(0, maxChars - total - 4) + "...");
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  const result = lines.join("\n");
  return result.length > 0 ? result : undefined;
}
