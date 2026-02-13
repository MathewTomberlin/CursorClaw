import { describe, expect, it } from "vitest";

import {
  BehaviorPolicyEngine,
  DeliveryPacer,
  GreetingPolicy,
  PresenceManager,
  TypingPolicy
} from "../src/responsiveness.js";

describe("responsiveness behavior policies", () => {
  it("emits typing events according to typing mode", () => {
    expect(new TypingPolicy("never").eventsForTurn({ isComplex: true, hasToolCalls: true })).toEqual([]);
    expect(new TypingPolicy("instant").eventsForTurn({ isComplex: false, hasToolCalls: false })).toEqual([
      "typing:start"
    ]);
    expect(new TypingPolicy("thinking").eventsForTurn({ isComplex: true, hasToolCalls: false })).toEqual([
      "typing:start",
      "typing:keepalive"
    ]);
    expect(new TypingPolicy("message").eventsForTurn({ isComplex: false, hasToolCalls: false })).toEqual([
      "typing:start",
      "typing:stop"
    ]);
  });

  it("enforces pacing to avoid burst message sends", () => {
    const pacer = new DeliveryPacer(1_000);
    expect(pacer.shouldSend("c1", 10_000)).toBe(true);
    expect(pacer.shouldSend("c1", 10_500)).toBe(false);
    expect(pacer.shouldSend("c1", 11_100)).toBe(true);
  });

  it("applies greeting cooldown for thread re-entry", () => {
    const policy = new GreetingPolicy(10_000);
    expect(policy.shouldGreet("thread-a", true, 1_000)).toBe(true);
    expect(policy.shouldGreet("thread-a", true, 5_000)).toBe(false);
    expect(policy.shouldGreet("thread-a", true, 12_000)).toBe(true);
    expect(policy.shouldGreet("thread-a", false, 13_000)).toBe(false);
  });

  it("combines typing, pacing, greeting, and presence in behavior engine", () => {
    const presence = new PresenceManager();
    const engine = new BehaviorPolicyEngine({
      typingPolicy: new TypingPolicy("thinking"),
      presenceManager: presence,
      deliveryPacer: new DeliveryPacer(1_000),
      greetingPolicy: new GreetingPolicy(10_000)
    });
    const first = engine.planSend({
      channelId: "c1",
      threadId: "t1",
      isNewThread: true,
      isComplex: true,
      hasToolCalls: true
    }, 1_000);
    expect(first.allowSend).toBe(true);
    expect(first.shouldGreet).toBe(true);
    expect(first.typingEvents).toContain("typing:keepalive");
    expect(presence.get("c1", 5_000, 1_100)?.status).toBe("online");

    const second = engine.planSend({
      channelId: "c1",
      threadId: "t1",
      isNewThread: true,
      isComplex: false,
      hasToolCalls: false
    }, 1_500);
    expect(second.allowSend).toBe(false);
  });

  it("does not consume greeting cooldown when a send is paced", () => {
    const engine = new BehaviorPolicyEngine({
      typingPolicy: new TypingPolicy("message"),
      presenceManager: new PresenceManager(),
      deliveryPacer: new DeliveryPacer(1_000),
      greetingPolicy: new GreetingPolicy(10_000)
    });

    const warmup = engine.planSend({
      channelId: "c1",
      threadId: "existing-thread",
      isNewThread: false,
      isComplex: false,
      hasToolCalls: false
    }, 1_000);
    expect(warmup.allowSend).toBe(true);

    const paced = engine.planSend({
      channelId: "c1",
      threadId: "new-thread",
      isNewThread: true,
      isComplex: false,
      hasToolCalls: false
    }, 1_500);
    expect(paced.allowSend).toBe(false);
    expect(paced.shouldGreet).toBe(false);

    const nextAllowed = engine.planSend({
      channelId: "c1",
      threadId: "new-thread",
      isNewThread: true,
      isComplex: false,
      hasToolCalls: false
    }, 2_100);
    expect(nextAllowed.allowSend).toBe(true);
    expect(nextAllowed.shouldGreet).toBe(true);
  });
});
