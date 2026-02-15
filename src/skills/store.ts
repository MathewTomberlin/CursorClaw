/**
 * Per-profile skills store: installed manifest and directory layout.
 * Credentials are not stored here; use credential store keyed by (profileId, skillId, keyName).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledSkillRecord, SkillsManifest } from "./types.js";

const SKILLS_ROOT = "skills";
const INSTALLED_SUBDIR = "installed";
const CREDENTIALS_SUBDIR = "credentials";
const MANIFEST_FILE = "manifest.json";

export const skillsDirs = {
  root: SKILLS_ROOT,
  installed: join(SKILLS_ROOT, INSTALLED_SUBDIR),
  installedManifest: join(SKILLS_ROOT, INSTALLED_SUBDIR, MANIFEST_FILE),
  credentials: join(SKILLS_ROOT, CREDENTIALS_SUBDIR)
} as const;

/**
 * Ensure profile root has skills/installed and skills/credentials directories.
 */
export async function ensureSkillsDirs(profileRoot: string): Promise<void> {
  await mkdir(join(profileRoot, skillsDirs.installed), { recursive: true });
  await mkdir(join(profileRoot, skillsDirs.credentials), { recursive: true });
}

/**
 * Read installed skills manifest from profile root. Returns empty list if missing.
 */
export async function readInstalledManifest(profileRoot: string): Promise<InstalledSkillRecord[]> {
  await ensureSkillsDirs(profileRoot);
  const path = join(profileRoot, skillsDirs.installedManifest);
  try {
    const raw = await readFile(path, "utf8");
    const manifest = JSON.parse(raw) as SkillsManifest;
    return Array.isArray(manifest.skills) ? manifest.skills : [];
  } catch {
    return [];
  }
}

/**
 * Write installed skills manifest to profile root.
 */
export async function writeInstalledManifest(
  profileRoot: string,
  skills: InstalledSkillRecord[]
): Promise<void> {
  await ensureSkillsDirs(profileRoot);
  const path = join(profileRoot, skillsDirs.installedManifest);
  await writeFile(path, JSON.stringify({ skills }, null, 2), "utf8");
}
