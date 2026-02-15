/**
 * Profile-scoped credential store for skills.
 * Keys are (profileRoot, skillId, keyName). Values are never returned to the agent or included in prompts/logs.
 * Use only for runtime resolution when invoking a skill's API; never inject into model context.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillsDirs, ensureSkillsDirs } from "./store.js";

const SAFE_SKILL_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_KEY_NAME = /^[a-zA-Z0-9_-]+$/;

function assertSafeSkillId(skillId: string): void {
  if (!SAFE_SKILL_ID.test(skillId)) {
    throw new Error("skillId must match [a-zA-Z0-9_-]+");
  }
}

function assertSafeKeyName(keyName: string): void {
  if (!SAFE_KEY_NAME.test(keyName)) {
    throw new Error("keyName must match [a-zA-Z0-9_-]+");
  }
}

function credentialsPath(profileRoot: string, skillId: string): string {
  return join(profileRoot, skillsDirs.credentials, `${skillId}.json`);
}

async function readCredentialFile(profileRoot: string, skillId: string): Promise<Record<string, string>> {
  const path = credentialsPath(profileRoot, skillId);
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (data === null || typeof data !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Get a credential value. Only use in secure runtime paths (e.g. calling an external API); never pass to the model or logs.
 */
export async function getCredential(
  profileRoot: string,
  skillId: string,
  keyName: string
): Promise<string | undefined> {
  assertSafeSkillId(skillId);
  assertSafeKeyName(keyName);
  const data = await readCredentialFile(profileRoot, skillId);
  return data[keyName];
}

/**
 * Set a credential value. Value is never logged.
 */
export async function setCredential(
  profileRoot: string,
  skillId: string,
  keyName: string,
  value: string
): Promise<void> {
  assertSafeSkillId(skillId);
  assertSafeKeyName(keyName);
  await ensureSkillsDirs(profileRoot);
  const data = await readCredentialFile(profileRoot, skillId);
  data[keyName] = value;
  const path = credentialsPath(profileRoot, skillId);
  await writeFile(path, JSON.stringify(data, null, 0), "utf8");
}

/**
 * Delete a credential by key name.
 */
export async function deleteCredential(
  profileRoot: string,
  skillId: string,
  keyName: string
): Promise<boolean> {
  assertSafeSkillId(skillId);
  assertSafeKeyName(keyName);
  const data = await readCredentialFile(profileRoot, skillId);
  if (!(keyName in data)) return false;
  delete data[keyName];
  const path = credentialsPath(profileRoot, skillId);
  if (Object.keys(data).length === 0) {
    const { unlink } = await import("node:fs/promises");
    await unlink(path).catch(() => {});
    return true;
  }
  await writeFile(path, JSON.stringify(data, null, 0), "utf8");
  return true;
}

/**
 * List credential names for a skill. Returns names only; never returns values.
 */
export async function listCredentialNames(profileRoot: string, skillId: string): Promise<string[]> {
  assertSafeSkillId(skillId);
  const data = await readCredentialFile(profileRoot, skillId);
  return Object.keys(data);
}
