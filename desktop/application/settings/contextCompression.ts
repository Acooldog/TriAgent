import type { ChatMessage } from "../model/modelProtocol";

export interface CompressionOptions {
  thresholdTokens: number;
  preserveRecentMessages: number;
  markdownThresholdTokens?: number;
  markdownMaxRatio?: number;
  writeMarkdown?: boolean;
}

export interface CompressionCheckpoint {
  version: 1;
  createdAt: string;
  originalMessageCount: number;
  retainedMessageCount: number;
  estimatedTokens: number;
  summary: { role: "system"; content: string };
  messages: ChatMessage[];
  compressedMessages: ChatMessage[];
}

export interface CompressionResult {
  messages: ChatMessage[];
  checkpoint: CompressionCheckpoint | null;
  markdown: string | null;
  compressed: boolean;
  fallback: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reason: string;
}

export type SummaryBuilder = (messages: ChatMessage[]) => Promise<string>;

export class StructuredContextCompressor {
  public constructor(private readonly summaryBuilder: SummaryBuilder = defaultSummaryBuilder, private readonly now: () => Date = () => new Date()) {}

  public async compress(messages: ChatMessage[], options: CompressionOptions): Promise<CompressionResult> {
    const before = estimateMessageTokens(messages);
    if (before < options.thresholdTokens || messages.length <= options.preserveRecentMessages) {
      return { messages: [...messages], checkpoint: null, markdown: null, compressed: false, fallback: false, estimatedTokensBefore: before, estimatedTokensAfter: before, reason: "threshold-not-reached" };
    }
    try {
      const retained = messages.slice(-options.preserveRecentMessages);
      const historical = messages.slice(0, -options.preserveRecentMessages);
      const summary = await this.summaryBuilder(historical);
      const compressedMessages: ChatMessage[] = [{ role: "system", content: summary }, ...retained];
      const checkpoint: CompressionCheckpoint = {
        version: 1,
        createdAt: this.now().toISOString(),
        originalMessageCount: messages.length,
        retainedMessageCount: retained.length,
        estimatedTokens: before,
        summary: compressedMessages[0] as { role: "system"; content: string },
        messages: [...messages],
        compressedMessages,
      };
      const after = estimateMessageTokens(compressedMessages);
      const markdown = checkpointToMarkdown(checkpoint);
      const markdownTokens = estimateTextTokens(markdown);
      const markdownMaxRatio = options.markdownMaxRatio ?? 0.8;
      const writeMarkdown = options.writeMarkdown === true
        && before >= (options.markdownThresholdTokens ?? options.thresholdTokens)
        && markdownTokens <= Math.floor(after * markdownMaxRatio);
      return { messages: compressedMessages, checkpoint, markdown: writeMarkdown ? markdown : null, compressed: true, fallback: false, estimatedTokensBefore: before, estimatedTokensAfter: after, reason: "compressed" };
    } catch {
      return { messages: [...messages], checkpoint: null, markdown: null, compressed: false, fallback: true, estimatedTokensBefore: before, estimatedTokensAfter: before, reason: "compression-failed" };
    }
  }
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((total, message) => total + JSON.stringify(message).length, 0) / 4);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function defaultSummaryBuilder(messages: ChatMessage[]): Promise<string> {
  const highlights = messages.map((message) => `${message.role}: ${(message.content ?? "").slice(0, 240)}`).join("\n");
  return Promise.resolve(`结构化历史摘要\n${highlights}`);
}

function checkpointToMarkdown(checkpoint: CompressionCheckpoint): string {
  return ["# Session Checkpoint", "", `- Created: ${checkpoint.createdAt}`, `- Messages: ${checkpoint.originalMessageCount} -> ${checkpoint.retainedMessageCount}`, `- Estimated tokens: ${checkpoint.estimatedTokens}`, "", "## Summary", "", checkpoint.summary.content].join("\n");
}
