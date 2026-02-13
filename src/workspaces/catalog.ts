import { basename } from "node:path";
import { stat } from "node:fs/promises";

export interface WorkspaceRootConfig {
  id?: string;
  path: string;
  priority?: number;
  enabled?: boolean;
}

export interface WorkspaceRoot {
  id: string;
  path: string;
  priority: number;
  enabled: boolean;
  repo: string;
}

export interface WorkspaceCatalogOptions {
  roots: WorkspaceRootConfig[];
}

export class WorkspaceCatalog {
  private readonly roots: WorkspaceRoot[];

  constructor(options: WorkspaceCatalogOptions) {
    this.roots = options.roots.map((root, index) => ({
      id: root.id ?? `ws-${index + 1}`,
      path: root.path,
      priority: root.priority ?? index,
      enabled: root.enabled ?? true,
      repo: basename(root.path) || `repo-${index + 1}`
    }));
  }

  listRoots(includeDisabled = false): WorkspaceRoot[] {
    return this.roots
      .filter((root) => includeDisabled || root.enabled)
      .sort((lhs, rhs) => lhs.priority - rhs.priority)
      .map((root) => ({ ...root }));
  }

  async healthCheck(): Promise<Array<WorkspaceRoot & { healthy: boolean; reason?: string }>> {
    const out: Array<WorkspaceRoot & { healthy: boolean; reason?: string }> = [];
    for (const root of this.roots) {
      try {
        const info = await stat(root.path);
        if (!info.isDirectory()) {
          out.push({
            ...root,
            healthy: false,
            reason: "path is not a directory"
          });
          continue;
        }
        out.push({
          ...root,
          healthy: true
        });
      } catch (error) {
        out.push({
          ...root,
          healthy: false,
          reason: String(error)
        });
      }
    }
    return out;
  }
}
