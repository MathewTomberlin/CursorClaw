interface IterationState {
  count: number;
  resetCount: number;
  lastResetAt?: string;
}

export interface ReasoningResetOptions {
  iterationThreshold: number;
}

export class ReasoningResetController {
  private readonly stateBySession = new Map<string, IterationState>();

  constructor(private readonly options: ReasoningResetOptions) {}

  noteIteration(sessionId: string): { shouldReset: boolean; iteration: number; resetCount: number } {
    const state = this.stateBySession.get(sessionId) ?? {
      count: 0,
      resetCount: 0
    };
    state.count += 1;
    let shouldReset = false;
    if (state.count >= this.options.iterationThreshold) {
      shouldReset = true;
      state.count = 0;
      state.resetCount += 1;
      state.lastResetAt = new Date().toISOString();
    }
    this.stateBySession.set(sessionId, state);
    return {
      shouldReset,
      iteration: state.count,
      resetCount: state.resetCount
    };
  }

  noteTaskResolved(sessionId: string): void {
    this.stateBySession.delete(sessionId);
  }

  getState(sessionId: string): { iteration: number; resetCount: number; lastResetAt?: string } {
    const state = this.stateBySession.get(sessionId);
    if (!state) {
      return {
        iteration: 0,
        resetCount: 0
      };
    }
    return {
      iteration: state.count,
      resetCount: state.resetCount,
      ...(state.lastResetAt ? { lastResetAt: state.lastResetAt } : {})
    };
  }
}
