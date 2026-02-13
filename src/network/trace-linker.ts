export interface RouteModuleLink {
  route: string;
  candidates: Array<{
    modulePath: string;
    score: number;
    reason: string;
  }>;
}

export class TraceLinker {
  linkRouteToModules(args: {
    route: string;
    indexedModulePaths: string[];
    maxCandidates?: number;
  }): RouteModuleLink {
    const maxCandidates = Math.max(1, Math.min(20, args.maxCandidates ?? 6));
    const routeTokens = tokenizeRoute(args.route);
    const scored = args.indexedModulePaths
      .map((modulePath) => {
        const pathTokens = modulePath
          .toLowerCase()
          .split(/[^a-z0-9_]+/g)
          .filter((token) => token.length > 0);
        const overlap = intersectionSize(new Set(routeTokens), new Set(pathTokens));
        const score = routeTokens.length === 0 ? 0 : overlap / routeTokens.length;
        return {
          modulePath,
          score,
          reason: overlap > 0 ? "token-overlap" : "none"
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((lhs, rhs) => rhs.score - lhs.score)
      .slice(0, maxCandidates);
    return {
      route: args.route,
      candidates: scored
    };
  }
}

function tokenizeRoute(route: string): string[] {
  return route
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length > 0);
}

function intersectionSize(lhs: Set<string>, rhs: Set<string>): number {
  let count = 0;
  for (const token of lhs) {
    if (rhs.has(token)) {
      count += 1;
    }
  }
  return count;
}
