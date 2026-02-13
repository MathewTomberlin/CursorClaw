import { describe, expect, it } from "vitest";

import { ChannelHub, LocalEchoChannelAdapter, SlackChannelAdapter } from "../src/channels.js";

describe("channel adapter hub", () => {
  it("routes slack-prefixed channels to slack adapter skeleton", async () => {
    const hub = new ChannelHub();
    hub.register(
      new SlackChannelAdapter({
        enabled: true,
        botToken: "xoxb-test",
        defaultChannel: "general"
      })
    );
    hub.register(new LocalEchoChannelAdapter());

    const sent = await hub.send({
      channelId: "slack:C123",
      text: "hello slack"
    });
    expect(sent.provider).toBe("slack");
    expect(sent.delivered).toBe(true);
    expect(sent.messageId).toContain("slack_");
  });

  it("falls back to local adapter when no specific provider matches", async () => {
    const hub = new ChannelHub();
    hub.register(new LocalEchoChannelAdapter());

    const sent = await hub.send({
      channelId: "dm:user-1",
      text: "hello local"
    });
    expect(sent.provider).toBe("local");
    expect(sent.delivered).toBe(true);
    expect(sent.messageId).toContain("local_");
  });
});
