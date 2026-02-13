export interface ActionEnvelope {
  actionId: string;
  at: string;
  runId: string;
  sessionId: string;
  actionType: string;
  confidenceScore: number;
  confidenceRationale: string[];
  requiresHumanHint: boolean;
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
