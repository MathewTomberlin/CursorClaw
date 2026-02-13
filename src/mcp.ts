export interface McpResourceDescriptor {
  server: string;
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string;
}

export interface McpServerAdapter {
  id: string;
  listResources(): Promise<McpResourceDescriptor[]>;
  readResource(uri: string): Promise<{
    uri: string;
    mimeType?: string;
    text: string;
  }>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

export interface McpRegistryOptions {
  allowedServers: string[];
}

export class McpRegistry {
  private readonly adapters = new Map<string, McpServerAdapter>();

  constructor(private readonly options: McpRegistryOptions) {}

  register(adapter: McpServerAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  listServers(): string[] {
    return [...this.adapters.keys()];
  }

  async listResources(server?: string): Promise<McpResourceDescriptor[]> {
    if (server) {
      const adapter = this.resolveAdapter(server);
      return adapter.listResources();
    }
    const resources: McpResourceDescriptor[] = [];
    for (const adapter of this.allowedAdapters()) {
      resources.push(...(await adapter.listResources()));
    }
    return resources;
  }

  async readResource(args: { server: string; uri: string }): Promise<{
    server: string;
    uri: string;
    mimeType?: string;
    text: string;
  }> {
    const adapter = this.resolveAdapter(args.server);
    const value = await adapter.readResource(args.uri);
    return {
      server: args.server,
      uri: value.uri,
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
      text: value.text
    };
  }

  async listTools(server?: string): Promise<McpToolDescriptor[]> {
    if (server) {
      const adapter = this.resolveAdapter(server);
      return adapter.listTools();
    }
    const out: McpToolDescriptor[] = [];
    for (const adapter of this.allowedAdapters()) {
      out.push(...(await adapter.listTools()));
    }
    return out;
  }

  async callTool(args: {
    server: string;
    tool: string;
    input: unknown;
  }): Promise<unknown> {
    const adapter = this.resolveAdapter(args.server);
    return adapter.callTool(args.tool, args.input);
  }

  private resolveAdapter(server: string): McpServerAdapter {
    if (this.options.allowedServers.length > 0 && !this.options.allowedServers.includes(server)) {
      throw new Error(`mcp server is not allowed by policy: ${server}`);
    }
    const adapter = this.adapters.get(server);
    if (!adapter) {
      throw new Error(`mcp server not registered: ${server}`);
    }
    return adapter;
  }

  private allowedAdapters(): McpServerAdapter[] {
    if (this.options.allowedServers.length === 0) {
      return [...this.adapters.values()];
    }
    return this.options.allowedServers
      .map((serverId) => this.adapters.get(serverId))
      .filter((adapter): adapter is McpServerAdapter => Boolean(adapter));
  }
}

export class InMemoryMcpServerAdapter implements McpServerAdapter {
  readonly id: string;
  private readonly resources = new Map<string, { text: string; mimeType?: string; name?: string }>();
  private readonly tools = new Map<string, (args: unknown) => Promise<unknown>>();

  constructor(serverId: string) {
    this.id = serverId;
  }

  defineResource(uri: string, text: string, mimeType = "text/plain", name?: string): void {
    this.resources.set(uri, {
      text,
      mimeType,
      ...(name !== undefined ? { name } : {})
    });
  }

  defineTool(name: string, handler: (args: unknown) => Promise<unknown>): void {
    this.tools.set(name, handler);
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    return [...this.resources.entries()].map(([uri, value]) => ({
      server: this.id,
      uri,
      ...(value.name !== undefined ? { name: value.name } : {}),
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {})
    }));
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text: string }> {
    const value = this.resources.get(uri);
    if (!value) {
      throw new Error(`mcp resource not found: ${uri}`);
    }
    return {
      uri,
      text: value.text,
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {})
    };
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return [...this.tools.keys()].map((name) => ({
      server: this.id,
      name
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`mcp tool not found: ${name}`);
    }
    return tool(args);
  }
}
