import type {
  AnalyzerPlugin,
  CollectorPlugin,
  PluginArtifact,
  PluginContext,
  PluginInsight,
  PromptMessage,
  SynthesizerPlugin
} from "./types.js";

export interface PluginHostOptions {
  defaultTimeoutMs: number;
}

export interface PluginPipelineResult {
  messages: PromptMessage[];
  diagnostics: string[];
}

export class PluginHost {
  private readonly collectors: CollectorPlugin[] = [];
  private readonly analyzers: AnalyzerPlugin[] = [];
  private readonly synthesizers: SynthesizerPlugin[] = [];

  constructor(private readonly options: PluginHostOptions) {}

  registerCollector(plugin: CollectorPlugin): void {
    this.collectors.push(plugin);
  }

  registerAnalyzer(plugin: AnalyzerPlugin): void {
    this.analyzers.push(plugin);
  }

  registerSynthesizer(plugin: SynthesizerPlugin): void {
    this.synthesizers.push(plugin);
  }

  async run(context: PluginContext): Promise<PluginPipelineResult> {
    const diagnostics: string[] = [];

    const collectedArtifacts: PluginArtifact[] = [];
    for (const plugin of this.collectors) {
      try {
        const artifacts = await this.withTimeout(
          () => plugin.collect(context),
          plugin.timeoutMs,
          `collector:${plugin.id}`
        );
        collectedArtifacts.push(...artifacts);
      } catch (error) {
        diagnostics.push(`collector:${plugin.id}: ${String(error)}`);
      }
    }

    const generatedInsights: PluginInsight[] = [];
    for (const plugin of this.analyzers) {
      try {
        const insights = await this.withTimeout(
          () => plugin.analyze(context, collectedArtifacts),
          plugin.timeoutMs,
          `analyzer:${plugin.id}`
        );
        generatedInsights.push(...insights);
      } catch (error) {
        diagnostics.push(`analyzer:${plugin.id}: ${String(error)}`);
      }
    }

    const synthesizedMessages: PromptMessage[] = [];
    for (const plugin of this.synthesizers) {
      try {
        const messages = await this.withTimeout(
          () => plugin.synthesize(context, generatedInsights),
          plugin.timeoutMs,
          `synthesizer:${plugin.id}`
        );
        synthesizedMessages.push(...messages);
      } catch (error) {
        diagnostics.push(`synthesizer:${plugin.id}: ${String(error)}`);
      }
    }

    return {
      messages: synthesizedMessages,
      diagnostics
    };
  }

  private async withTimeout<T>(
    run: () => Promise<T>,
    timeoutMs: number | undefined,
    pluginLabel: string
  ): Promise<T> {
    const resolvedTimeoutMs = timeoutMs ?? this.options.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`plugin timeout (${pluginLabel})`));
      }, resolvedTimeoutMs);
      void run()
        .then((value) => {
          clearTimeout(timeoutHandle);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }
}
