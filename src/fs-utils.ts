import { readFile } from "node:fs/promises";

/**
 * Read a file as UTF-8 without throwing on invalid encoding. Uses buffer decode
 * with replacement characters so bad bytes do not crash the process. Use for
 * user-editable or external files (e.g. MEMORY.md, daily memory, substrate).
 */
export async function safeReadUtf8(
  path: string,
  options?: { maxChars?: number }
): Promise<string | undefined> {
  try {
    const buf = await readFile(path);
    let s = buf.toString("utf8");
    if (options?.maxChars != null && s.length > options.maxChars) {
      s = s.slice(0, options.maxChars) + "\n\n[... truncated for length]";
    }
    return s;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EISDIR") {
      return undefined;
    }
    // eslint-disable-next-line no-console
    console.warn("[CursorClaw] safeReadUtf8 skip:", path, (err as Error).message);
    return undefined;
  }
}
