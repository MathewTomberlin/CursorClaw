/**
 * File-based inter-agent mailbox: send/receive messages between profiles.
 * See docs/inter-agent-communication.md.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Envelope {
  id: string;
  from: string;
  to: string;
  at: string;
  type: string;
  payload: unknown;
  replyTo?: string;
}

const INBOX_DIR = "mailbox/inbox";
const PROCESSED_DIR = "mailbox/processed";

/**
 * Ensure mailbox/inbox and mailbox/processed exist under profileRoot.
 */
async function ensureMailboxDirs(profileRoot: string): Promise<void> {
  await mkdir(join(profileRoot, INBOX_DIR), { recursive: true });
  await mkdir(join(profileRoot, PROCESSED_DIR), { recursive: true });
}

/**
 * Receive messages for the given profile: read all files from mailbox/inbox,
 * return envelopes, then move files to mailbox/processed so they are not delivered again.
 */
export async function receiveMessages(profileRoot: string): Promise<Envelope[]> {
  const inboxPath = join(profileRoot, INBOX_DIR);
  const processedPath = join(profileRoot, PROCESSED_DIR);
  await ensureMailboxDirs(profileRoot);
  let names: string[];
  try {
    names = await readdir(inboxPath);
  } catch {
    return [];
  }
  const jsonFiles = names.filter((n) => n.endsWith(".json"));
  const envelopes: Envelope[] = [];
  for (const name of jsonFiles) {
    const filePath = join(inboxPath, name);
    try {
      const raw = await readFile(filePath, "utf-8");
      const envelope = JSON.parse(raw) as Envelope;
      if (envelope.id && envelope.from && envelope.to && envelope.at && envelope.type !== undefined) {
        envelopes.push(envelope);
      }
      await rename(filePath, join(processedPath, name));
    } catch {
      try {
        await unlink(filePath);
      } catch {
        // ignore
      }
    }
  }
  return envelopes;
}

export interface SendMessageOptions {
  /** Max files to keep in inbox; oldest (by filename) removed after write. Omit for no limit. */
  maxInboxFiles?: number;
}

/**
 * Send a message to the recipient profile by writing the envelope to
 * recipientProfileRoot/mailbox/inbox/<id>.json. Ensures mailbox dirs exist.
 * Optionally trims oldest files when over maxInboxFiles.
 */
export async function sendMessage(
  recipientProfileRoot: string,
  envelope: Envelope,
  options: SendMessageOptions = {}
): Promise<void> {
  await ensureMailboxDirs(recipientProfileRoot);
  const inboxPath = join(recipientProfileRoot, INBOX_DIR);
  const filePath = join(inboxPath, `${envelope.id}.json`);
  await writeFile(filePath, JSON.stringify(envelope, null, 0), "utf-8");
  const { maxInboxFiles } = options;
  if (maxInboxFiles != null && maxInboxFiles > 0) {
    let names: string[];
    try {
      names = (await readdir(inboxPath)).sort();
    } catch {
      return;
    }
    while (names.length > maxInboxFiles) {
      const oldest = names.shift();
      if (!oldest) break;
      try {
        await unlink(join(inboxPath, oldest));
      } catch {
        // ignore
      }
    }
  }
}
