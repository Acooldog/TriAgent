import type { ChatMessage } from "./modelProtocol";

export interface CompressionOptions { thresholdTokens: number; preserveRecentMessages: number; markdownThresholdTokens?: number; writeMarkdown?: boolean; }
export interface CompressionCheckpoint { version: 1; createdAt: string; originalMessageCount: number; retainedMessageCount: number; estimatedTokens: number; summary: { role: "system"; content: string }; messages: ChatMessage[]; }
export interface CompressionResult { messages: ChatMessage[]; checkpoint: CompressionCheckpoint | null; markdown: string | null; compressed: boolean; fallback: boolean; estimatedTokensBefore: number; estimatedTokensAfter: number; reason: string; }
export type SummaryBuilder = (messages: ChatMessage[]) => Promise<string>;

export class StructuredContextCompressor {
  public constructor(private readonly summaryBuilder: SummaryBuilder = defaultSummaryBuilder, private readonly now: () => Date = () => new Date()) {}
  public async compress(messages: ChatMessage[], options: CompressionOptions): Promise<CompressionResult> {
    const before = estimateMessageTokens(messages);
    if (before < options.thresholdTokens || messages.length <= options.preserveRecentMessages) return { messages: [...messages], checkpoint: null, markdown: null, compressed: false, fallback: false, estimatedTokensBefore: before, estimatedTokensAfter: before, reason: "threshold-not-reached" };
    try {
      const retained = messages.slice(-options.preserveRecentMessages);
      const summary = await this.summaryBuilder(messages.slice(0, -options.preserveRecentMessages));
      const checkpoint: CompressionCheckpoint = { version: 1, createdAt: this.now().toISOString(), originalMessageCount: messages.length, retainedMessageCount: retained.length, estimatedTokens: before, summary: { role: "system", content: summary }, messages: [...messages] };
      const compressedMessages: ChatMessage[] = [checkpoint.summary, ...retained];
      const after = estimateMessageTokens(compressedMessages);
      const writeMarkdown = options.writeMarkdown === true && before >= (options.markdownThresholdTokens ?? options.thresholdTokens);
      return { messages: compressedMessages, checkpoint, markdown: writeMarkdown ? checkpointToMarkdown(checkpoint) : null, compressed: true, fallback: false, estimatedTokensBefore: before, estimatedTokensAfter: after, reason: "compressed" };
    } catch {
      return { messages: [...messages], checkpoint: null, markdown: null, compressed: false, fallback: true, estimatedTokensBefore: before, estimatedTokensAfter: before, reason: "compression-failed" };
    }
  }
}

export function estimateMessageTokens(messages: ChatMessage[]): number { return Math.ceil(messages.reduce((total, message) => total + JSON.stringify(message).length, 0) / 4); }
function defaultSummaryBuilder(messages: ChatMessage[]): Promise<string> { return Promise.resolve(`结构化历史摘要\n${messages.map((message) => `${message.role}: ${(message.content ?? "").slice(0, 240)}`).join("\n")}`); }
function checkpointToMarkdown(checkpoint: CompressionCheckpoint): string { return ["# Session Checkpoint", "", `- Created: ${checkpoint.createdAt}`, `- Messages: ${checkpoint.originalMessageCount} -> ${checkpoint.retainedMessageCount}`, `- Estimated tokens: ${checkpoint.estimatedTokens}`, "", "## Summary", "", checkpoint.summary.content].join("\n"); }
