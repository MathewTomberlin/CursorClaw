export interface FlakyScoreResult {
  flakyScore: number;
  confidence: number;
  passCount: number;
  failCount: number;
}

export function computeFlakyScore(outcomes: boolean[]): FlakyScoreResult {
  const passCount = outcomes.filter(Boolean).length;
  const failCount = outcomes.length - passCount;
  if (outcomes.length === 0) {
    return {
      flakyScore: 0,
      confidence: 0,
      passCount: 0,
      failCount: 0
    };
  }
  const transitions = countTransitions(outcomes);
  const instability = transitions / Math.max(1, outcomes.length - 1);
  const failureRate = failCount / outcomes.length;
  const flakyScore = Math.round((instability * 0.7 + failureRate * 0.3) * 100);
  return {
    flakyScore,
    confidence: Math.min(100, outcomes.length * 20),
    passCount,
    failCount
  };
}

function countTransitions(outcomes: boolean[]): number {
  let transitions = 0;
  for (let index = 1; index < outcomes.length; index += 1) {
    if (outcomes[index] !== outcomes[index - 1]) {
      transitions += 1;
    }
  }
  return transitions;
}
