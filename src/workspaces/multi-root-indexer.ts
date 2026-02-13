import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { WorkspaceRoot } from "./catalog.js";

export interface IndexedWorkspaceFile {
  workspaceId: string;
  workspacePath: string;
  repo: string;
  absolutePath: string;
  modulePath: string;
  language: string;
  sizeBytes: number;
  updatedAtMs: number;
  contentHash: string;
  content: string;
}

export interface MultiRootIndexerOptions {
  maxFilesPerRoot: number;
  maxFileBytes: number;
  includeExtensions: string[];
}

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "tmp",
  ".cursor"
]);

export class MultiRootIndexer {
  constructor(private readonly options: MultiRootIndexerOptions) {}

  async indexRoots(roots: WorkspaceRoot[]): Promise<IndexedWorkspaceFile[]> {
    const files: IndexedWorkspaceFile[] = [];
    for (const root of roots) {
      const rootFiles = await this.indexRoot(root);
      files.push(...rootFiles);
    }
    return files;
  }

  async indexRoot(root: WorkspaceRoot): Promise<IndexedWorkspaceFile[]> {
    const out: IndexedWorkspaceFile[] = [];
    await this.walk(root.path, async (absolutePath) => {
      if (out.length >= this.options.maxFilesPerRoot) {
        return false;
      }
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return true;
      }
      if (info.size > this.options.maxFileBytes) {
        return true;
      }
      const extension = extnameLower(absolutePath);
      if (!this.options.includeExtensions.includes(extension)) {
        return true;
      }
      const content = await readFile(absolutePath, "utf8");
      const contentHash = createHash("sha256").update(content).digest("hex");
      out.push({
        workspaceId: root.id,
        workspacePath: root.path,
        repo: root.repo,
        absolutePath,
        modulePath: relative(root.path, absolutePath),
        language: languageFromExtension(extension),
        sizeBytes: info.size,
        updatedAtMs: info.mtimeMs,
        contentHash,
        content
      });
      return true;
    });
    return out;
  }

  private async walk(
    root: string,
    onFile: (absolutePath: string) => Promise<boolean>
  ): Promise<void> {
    const entries = await readdir(root, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await this.walk(absolutePath, onFile);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const keepGoing = await onFile(absolutePath);
      if (!keepGoing) {
        return;
      }
    }
  }
}

function extnameLower(filePath: string): string {
  const index = filePath.lastIndexOf(".");
  if (index < 0) {
    return "";
  }
  return filePath.slice(index).toLowerCase();
}

function languageFromExtension(ext: string): string {
  if (ext === ".ts" || ext === ".tsx") {
    return "typescript";
  }
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    return "javascript";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".go") {
    return "go";
  }
  if (ext === ".rs") {
    return "rust";
  }
  if (ext === ".java") {
    return "java";
  }
  if (ext === ".json") {
    return "json";
  }
  if (ext === ".md") {
    return "markdown";
  }
  return "other";
}
