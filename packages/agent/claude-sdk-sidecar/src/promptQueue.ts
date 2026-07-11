import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type PromptQueueItem =
  | { type: "message"; message: SDKUserMessage }
  | { type: "close" };

export class AsyncPromptQueue {
  private readonly values: PromptQueueItem[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("prompt queue is closed");
    }
    this.offer({ type: "message", message });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.offer({ type: "close" });
  }

  async *iterate(): AsyncIterable<SDKUserMessage> {
    for (;;) {
      const next = await this.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  private offer(item: PromptQueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(
        item.type === "close"
          ? { done: true, value: undefined }
          : { done: false, value: item.message }
      );
      return;
    }
    this.values.push(item);
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const item = this.values.shift();
    if (item) {
      return Promise.resolve(
        item.type === "close"
          ? { done: true, value: undefined }
          : { done: false, value: item.message }
      );
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
