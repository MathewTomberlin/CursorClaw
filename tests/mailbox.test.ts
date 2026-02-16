import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { receiveMessages, sendMessage, type Envelope } from "../src/mailbox.js";

let profileA: string;
let profileB: string;

afterEach(async () => {
  for (const dir of [profileA, profileB].filter(Boolean)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  profileA = "";
  profileB = "";
});

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    from: "default",
    to: "Fun",
    at: new Date().toISOString(),
    type: "note",
    payload: { text: "hello" },
    ...overrides,
  };
}

describe("mailbox", () => {
  it("receiveMessages returns empty when inbox does not exist yet", async () => {
    profileA = await mkdtemp(join(tmpdir(), "mailbox-receive-empty-"));
    const messages = await receiveMessages(profileA);
    expect(messages).toEqual([]);
  });

  it("receiveMessages returns empty when inbox is empty", async () => {
    profileA = await mkdtemp(join(tmpdir(), "mailbox-receive-empty-dir-"));
    const messages = await receiveMessages(profileA);
    expect(messages).toEqual([]);
  });

  it("sendMessage creates inbox and writes envelope; receiveMessages returns and moves to processed", async () => {
    profileA = await mkdtemp(join(tmpdir(), "mailbox-send-"));
    profileB = await mkdtemp(join(tmpdir(), "mailbox-recv-"));
    const env = envelope({ id: "e1", from: "A", to: "B" });
    await sendMessage(profileB, env);
    const received = await receiveMessages(profileB);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: "e1", from: "A", to: "B", type: "note" });
    const again = await receiveMessages(profileB);
    expect(again).toEqual([]);
  });

  it("receiveMessages skips non-JSON files and invalid envelopes", async () => {
    profileA = await mkdtemp(join(tmpdir(), "mailbox-invalid-"));
    const inboxPath = join(profileA, "mailbox", "inbox");
    await mkdir(inboxPath, { recursive: true });
    await writeFile(join(inboxPath, "bad.txt"), "not json", "utf-8");
    await writeFile(join(inboxPath, "missing-fields.json"), JSON.stringify({ id: "x" }), "utf-8");
    const valid = envelope({ id: "valid-1" });
    await sendMessage(profileA, valid);
    const messages = await receiveMessages(profileA);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeDefined();
    expect(messages[0]!.id).toBe("valid-1");
  });

  it("sendMessage with maxInboxFiles trims oldest files", async () => {
    profileB = await mkdtemp(join(tmpdir(), "mailbox-retention-"));
    for (let i = 0; i < 5; i++) {
      await sendMessage(profileB, envelope({ id: `msg-${i}` }), { maxInboxFiles: 3 });
    }
    const received = await receiveMessages(profileB);
    expect(received).toHaveLength(3);
  });

  it("receiveMessages returns envelopes in inbox order and moves to processed", async () => {
    profileB = await mkdtemp(join(tmpdir(), "mailbox-multi-"));
    await sendMessage(profileB, envelope({ id: "first" }));
    await sendMessage(profileB, envelope({ id: "second" }));
    const first = await receiveMessages(profileB);
    expect(first.map((e) => e.id)).toContain("first");
    expect(first.map((e) => e.id)).toContain("second");
    expect(first).toHaveLength(2);
    const second = await receiveMessages(profileB);
    expect(second).toHaveLength(0);
  });
});
