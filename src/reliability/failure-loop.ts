interface FailureState {
  signature: string;
  count: number;
}

export interface FailureLoopGuardOptions {
  escalationThreshold: number;
}

export class FailureLoopGuard {
  private readonly stateBySession = new Map<string, FailureState>();

  constructor(private readonly options: FailureLoopGuardOptions) {}

  recordFailure(sessionId: string, error: unknown): void {
    const signature = normalizeErrorSignature(error);
    const existing = this.stateBySession.get(sessionId);
    if (!existing || existing.signature !== signature) {
      this.stateBySession.set(sessionId, {
        signature,
        count: 1
      });
      return;
    }
    existing.count += 1;
  }

  recordSuccess(sessionId: string): void {
    this.stateBySession.delete(sessionId);
  }

  requiresStepBack(sessionId: string): boolean {
    const state = this.stateBySession.get(sessionId);
    if (!state) {
      return false;
    }
    return state.count >= this.options.escalationThreshold;
  }

  getFailureCount(sessionId: string): number {
    return this.stateBySession.get(sessionId)?.count ?? 0;
  }
}

function normalizeErrorSignature(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return raw
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
