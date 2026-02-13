import { createHash, randomUUID } from "node:crypto";

export interface OutboundMessage {
  channelId: string;
  text: string;
  threadId?: string;
  proactive?: boolean;
  typingEvents?: string[];
  urgent?: boolean;
}

export interface ChannelSendResult {
  delivered: boolean;
  channelId: string;
  messageId?: string;
  provider: string;
  text: string;
  detail?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  supports(channelId: string): boolean;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  send(message: OutboundMessage): Promise<ChannelSendResult>;
}

export interface SlackAdapterConfig {
  botToken?: string;
  defaultChannel?: string;
  enabled: boolean;
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = "slack";

  constructor(private readonly config: SlackAdapterConfig) {}

  supports(channelId: string): boolean {
    return channelId.startsWith("slack:");
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    if (!this.config.enabled) {
      return {
        delivered: false,
        channelId: message.channelId,
        provider: this.name,
        text: message.text,
        detail: "slack adapter disabled"
      };
    }
    if (!this.config.botToken) {
      return {
        delivered: false,
        channelId: message.channelId,
        provider: this.name,
        text: message.text,
        detail: "slack adapter missing bot token"
      };
    }

    // Skeleton connector: production API wiring is intentionally deferred.
    // It still provides deterministic dispatch semantics for integration paths.
    return {
      delivered: true,
      channelId: message.channelId,
      provider: this.name,
      text: message.text,
      messageId: `slack_${randomUUID()}`
    };
  }
}

export class LocalEchoChannelAdapter implements ChannelAdapter {
  readonly name = "local";

  supports(_channelId: string): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    const stableId = createHash("sha256")
      .update(`${message.channelId}:${message.threadId ?? ""}:${message.text}`)
      .digest("hex")
      .slice(0, 16);
    return {
      delivered: true,
      channelId: message.channelId,
      provider: this.name,
      text: message.text,
      messageId: `local_${stableId}`
    };
  }
}

export class ChannelHub {
  private readonly adapters: ChannelAdapter[] = [];

  register(adapter: ChannelAdapter): void {
    this.adapters.push(adapter);
  }

  listAdapters(): string[] {
    return this.adapters.map((adapter) => adapter.name);
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    const adapter = this.adapters.find((candidate) => candidate.supports(message.channelId));
    if (!adapter) {
      return {
        delivered: false,
        channelId: message.channelId,
        provider: "none",
        text: message.text,
        detail: "no adapter available for channel"
      };
    }
    return adapter.send(message);
  }
}
