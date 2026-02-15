export type ChannelKind = "dm" | "group" | "web" | "mobile";

export type Decision = "allow" | "deny";

export type DecisionReasonCode =
  | "ALLOWED"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "AUTH_ROLE_MISMATCH"
  | "PROTO_VERSION_UNSUPPORTED"
  | "RATE_LIMITED"
  | "RISK_BLOCKED"
  | "DM_POLICY_BLOCKED"
  | "GROUP_POLICY_BLOCKED"
  | "TOOL_UNKNOWN"
  | "TOOL_SCHEMA_INVALID"
  | "TOOL_POLICY_BLOCKED"
  | "TOOL_DESTRUCTIVE_DENIED"
  | "TOOL_APPROVAL_REQUIRED"
  | "TOOL_EXEC_DENIED";

export interface PolicyDecisionLog {
  at: string;
  auditId: string;
  sessionId?: string;
  method?: string;
  tool?: string;
  decision: Decision;
  reasonCode: DecisionReasonCode;
  detail?: string;
}

export interface Provenance {
  sourceChannel: string;
  confidence: number;
  timestamp: string;
  sensitivity: SensitivityLabel;
}

export type SensitivityLabel = "public" | "private-user" | "secret" | "operational";

export interface MemoryRecord {
  id: string;
  sessionId: string;
  category: string;
  text: string;
  provenance: Provenance;
}

export interface SessionContext {
  sessionId: string;
  channelId: string;
  userId?: string;
  channelKind: ChannelKind;
}

export type LifecycleEventType =
  | "queued"
  | "started"
  | "tool"
  | "assistant"
  | "compaction"
  | "completed"
  | "failed";

export interface LifecycleEvent {
  type: LifecycleEventType;
  sessionId: string;
  runId: string;
  payload?: unknown;
  at: string;
}

export interface ToolCall {
  name: string;
  args: unknown;
}

export type AdapterEventType =
  | "assistant_delta"
  | "tool_call"
  | "usage"
  | "error"
  | "done";

export interface AdapterEvent {
  type: AdapterEventType;
  data?: unknown;
}

export interface ModelSessionHandle {
  id: string;
  model: string;
  authProfile?: string;
}

export interface SendTurnOptions {
  turnId: string;
  timeoutMs?: number;
}

export interface ModelAdapter {
  createSession(context: SessionContext): Promise<ModelSessionHandle>;
  sendTurn(
    session: ModelSessionHandle,
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    options: SendTurnOptions
  ): AsyncIterable<AdapterEvent>;
  cancel(turnId: string): Promise<void>;
  close(session: ModelSessionHandle): Promise<void>;
}

export interface RpcRequest {
  id?: string;
  version: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id?: string;
  auditId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** Minimal context passed to tool.execute; full type in tools.ts. */
export interface ToolExecuteContext {
  auditId: string;
  decisionLogs: PolicyDecisionLog[];
  provenance?: "system" | "operator" | "untrusted";
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: object;
  riskLevel: "low" | "high";
  execute: (args: unknown, context?: ToolExecuteContext) => Promise<unknown>;
  /** Optional: checksum or attestation for tool definition. Future versions may verify against allowlist. */
  toolDefinitionChecksum?: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  everyMs: number;
  minMs: number;
  maxMs: number;
  activeHours?: { startHour: number; endHour: number };
  visibility: "silent" | "visible";
  /** Optional custom instruction for the heartbeat turn. When HEARTBEAT.md exists, this is appended after its content. */
  prompt?: string;
}

export interface AutonomyBudgetConfig {
  maxPerHourPerChannel: number;
  maxPerDayPerChannel: number;
  quietHours?: { startHour: number; endHour: number };
}

export type CronExpressionType = "at" | "every" | "cron";

export interface CronJobDefinition {
  id: string;
  type: CronExpressionType;
  expression: string;
  isolated: boolean;
  maxRetries: number;
  backoffMs: number;
  nextRunAt?: number;
}

export interface WorkflowStep {
  id: string;
  requiresApproval: boolean;
  run: () => Promise<void>;
}

export interface WorkflowDefinition {
  id: string;
  steps: WorkflowStep[];
}
