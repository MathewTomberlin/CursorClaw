import type { IndexedWorkspaceFile } from "./multi-root-indexer.js";

export interface CrossRepoEdge {
  fromRepo: string;
  fromModule: string;
  toRepo: string;
  toModule?: string;
  kind: "import" | "http-call";
  signal: string;
  confidence: number;
}

export interface CrossRepoGraph {
  edges: CrossRepoEdge[];
  builtAt: string;
}

export class CrossRepoDependencyGraphBuilder {
  build(files: IndexedWorkspaceFile[]): CrossRepoGraph {
    const edges: CrossRepoEdge[] = [];
    const repoSet = new Set(files.map((file) => file.repo));
    for (const file of files) {
      const importMatches = extractImportTargets(file.content);
      for (const target of importMatches) {
        const repoMatch = [...repoSet].find((repo) => target.includes(repo) && repo !== file.repo);
        if (!repoMatch) {
          continue;
        }
        edges.push({
          fromRepo: file.repo,
          fromModule: file.modulePath,
          toRepo: repoMatch,
          kind: "import",
          signal: target,
          confidence: 0.78
        });
      }
      const apiCalls = extractHttpTargets(file.content);
      for (const target of apiCalls) {
        const repoMatch = [...repoSet].find((repo) => target.includes(repo) && repo !== file.repo);
        edges.push({
          fromRepo: file.repo,
          fromModule: file.modulePath,
          toRepo: repoMatch ?? "external-service",
          kind: "http-call",
          signal: target,
          confidence: repoMatch ? 0.74 : 0.45
        });
      }
    }
    return {
      edges,
      builtAt: new Date().toISOString()
    };
  }

  findSuspects(args: {
    sourceRepo: string;
    maxResults: number;
    minConfidence?: number;
  }, graph: CrossRepoGraph): CrossRepoEdge[] {
    const minConfidence = args.minConfidence ?? 0.6;
    return graph.edges
      .filter((edge) => edge.fromRepo === args.sourceRepo && edge.confidence >= minConfidence)
      .sort((lhs, rhs) => rhs.confidence - lhs.confidence)
      .slice(0, Math.max(1, args.maxResults));
  }
}

function extractImportTargets(content: string): string[] {
  const out: string[] = [];
  const pattern = /(?:from|require\()\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match !== null) {
    const target = match[1];
    if (target) {
      out.push(target);
    }
    match = pattern.exec(content);
  }
  return out;
}

function extractHttpTargets(content: string): string[] {
  const out: string[] = [];
  const pattern = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match !== null) {
    const target = match[0];
    if (target) {
      out.push(target);
    }
    match = pattern.exec(content);
  }
  return out;
}
