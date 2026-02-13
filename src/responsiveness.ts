export type TypingMode = "never" | "instant" | "thinking" | "message";

export class TypingPolicy {
  constructor(private readonly mode: TypingMode) {}

  eventsForTurn(args: { isComplex: boolean; hasToolCalls: boolean }): string[] {
    if (this.mode === "never") {
      return [];
    }
    if (this.mode === "instant") {
      return ["typing:start"];
    }
    if (this.mode === "thinking") {
      return args.isComplex || args.hasToolCalls ? ["typing:start", "typing:keepalive"] : [];
    }
    // message mode
    return ["typing:start", "typing:stop"];
  }
}

export interface PresenceRecord {
  status: "online" | "away" | "busy" | "offline";
  updatedAt: number;
}

export class PresenceManager {
  private readonly state = new Map<string, PresenceRecord>();

  set(channelId: string, status: PresenceRecord["status"], now = Date.now()): void {
    const existing = this.state.get(channelId);
    if (existing && existing.status === status) {
      existing.updatedAt = now;
      return;
    }
    this.state.set(channelId, { status, updatedAt: now });
  }

  get(channelId: string, ttlMs: number, now = Date.now()): PresenceRecord | null {
    const entry = this.state.get(channelId);
    if (!entry) {
      return null;
    }
    if (now - entry.updatedAt > ttlMs) {
      this.state.delete(channelId);
      return null;
    }
    return entry;
  }
}

export class DeliveryPacer {
  private readonly lastSentByChannel = new Map<string, number>();

  constructor(private readonly minInterMessageMs: number) {}

  shouldSend(channelId: string, now = Date.now(), urgent = false): boolean {
    if (urgent) {
      this.lastSentByChannel.set(channelId, now);
      return true;
    }
    const last = this.lastSentByChannel.get(channelId) ?? 0;
    if (now - last < this.minInterMessageMs) {
      return false;
    }
    this.lastSentByChannel.set(channelId, now);
    return true;
  }
}

export class GreetingPolicy {
  private readonly lastGreetingByThread = new Map<string, number>();

  constructor(private readonly cooldownMs = 2 * 60 * 60_000) {}

  shouldGreet(threadId: string, isNewThread: boolean, now = Date.now()): boolean {
    if (!isNewThread) {
      return false;
    }
    const last = this.lastGreetingByThread.get(threadId);
    if (last !== undefined && now - last < this.cooldownMs) {
      return false;
    }
    this.lastGreetingByThread.set(threadId, now);
    return true;
  }
}

export interface BehaviorPolicyEngineOptions {
  typingPolicy: TypingPolicy;
  presenceManager: PresenceManager;
  deliveryPacer: DeliveryPacer;
  greetingPolicy: GreetingPolicy;
}

export interface SendPlanInput {
  channelId: string;
  threadId: string;
  isNewThread: boolean;
  isComplex: boolean;
  hasToolCalls: boolean;
  urgent?: boolean;
}

export interface SendPlan {
  allowSend: boolean;
  typingEvents: string[];
  shouldGreet: boolean;
}

export class BehaviorPolicyEngine {
  constructor(private readonly options: BehaviorPolicyEngineOptions) {}

  planSend(input: SendPlanInput, now = Date.now()): SendPlan {
    this.options.presenceManager.set(input.channelId, "online", now);
    const allowSend = this.options.deliveryPacer.shouldSend(input.channelId, now, input.urgent ?? false);
    const typingEvents = this.options.typingPolicy.eventsForTurn({
      isComplex: input.isComplex,
      hasToolCalls: input.hasToolCalls
    });
    const shouldGreet = this.options.greetingPolicy.shouldGreet(input.threadId, input.isNewThread, now);
    return {
      allowSend,
      typingEvents,
      shouldGreet
    };
  }
}
