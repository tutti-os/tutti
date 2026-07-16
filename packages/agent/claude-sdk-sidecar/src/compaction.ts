import { numberValue, recordValue } from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import { contextWindowTokensFromModelUsage } from "./sdkMessages.ts";
import { emitUsageUpdated } from "./usage.ts";

type ContextUsageQuery = {
  getContextUsage?: () => Promise<unknown>;
};

export type ContextUsageSnapshotResult = "emitted" | "unavailable" | "stale";

export class CompactionTracker {
  private inProgress = false;
  private commandTurnId = "";
  private readonly completedTurnIds = new Set<string>();
  private readonly activeTurnId: () => string;
  private readonly ensureActive: (messageType: string) => void;
  private readonly clearPendingOrphans: () => void;
  private readonly getQuery: () => ContextUsageQuery | undefined;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private contextUsageRequestGeneration = 0;

  constructor(options: {
    activeTurnId: () => string;
    ensureActive: (messageType: string) => void;
    clearPendingOrphans: () => void;
    getQuery: () => ContextUsageQuery | undefined;
    emit: ClaudeSDKSidecarEventEmitter;
  }) {
    this.activeTurnId = options.activeTurnId;
    this.ensureActive = options.ensureActive;
    this.clearPendingOrphans = options.clearPendingOrphans;
    this.getQuery = options.getQuery;
    this.emit = options.emit;
  }

  selectCommand(turnId: string, isCompact: boolean): void {
    this.commandTurnId = isCompact ? turnId : "";
  }

  handleSystemMessage(
    subtype: string,
    message: Record<string, unknown>
  ): boolean {
    if (subtype === "status") {
      return this.handleStatus(message);
    }
    if (subtype !== "compact_boundary") {
      return false;
    }
    this.ensureActive("compact_boundary");
    const turnId = this.eventTurnId();
    this.emitBoundaryUsage(message, turnId);
    this.emitBoundaryCompletion();
    return true;
  }

  async emitContextUsageSnapshot(
    turnId: string,
    options: { modelUsage?: unknown; shouldEmit?: () => boolean } = {}
  ): Promise<ContextUsageSnapshotResult> {
    const requestGeneration = ++this.contextUsageRequestGeneration;
    const isCurrent = () =>
      requestGeneration === this.contextUsageRequestGeneration &&
      (!options.shouldEmit || options.shouldEmit());
    const query = this.getQuery();
    if (!query?.getContextUsage) {
      return "unavailable";
    }
    try {
      const contextUsage = recordValue(await query.getContextUsage());
      if (!isCurrent()) {
        return "stale";
      }
      if (!contextUsage) {
        return "unavailable";
      }
      const usedTokens = numberValue(contextUsage.totalTokens);
      const contextWindowTokens =
        contextWindowTokensFromModelUsage(options.modelUsage) ||
        numberValue(contextUsage.maxTokens);
      if (usedTokens <= 0 && contextWindowTokens <= 0) {
        return "unavailable";
      }
      emitUsageUpdated(this.emit, turnId, {
        contextWindow: {
          usedTokens,
          ...(contextWindowTokens > 0
            ? { totalTokens: contextWindowTokens }
            : {}),
          compactsAutomatically: contextUsage.isAutoCompactEnabled === true
        }
      });
      return "emitted";
    } catch {
      // Context usage is best-effort; result usage remains available.
      return isCurrent() ? "unavailable" : "stale";
    }
  }

  private handleStatus(message: Record<string, unknown>): boolean {
    if (message.status === "compacting") {
      this.ensureActive("compact_status");
      this.clearPendingOrphans();
      this.inProgress = true;
      this.emit({
        type: "compact_started",
        payload: {
          turnId: this.activeTurnId(),
          content: "Compacting..."
        }
      });
      return true;
    }
    const compactResult = stringValue(message.compact_result);
    if (compactResult === "success" && this.inProgress) {
      this.inProgress = false;
      const turnId = this.eventTurnId();
      this.emitCompleted(turnId, "Compacting completed.");
      void this.emitContextUsageSnapshot(turnId);
      return true;
    }
    if (compactResult === "failed" && this.inProgress) {
      this.inProgress = false;
      const turnId = this.activeTurnId();
      const reason = collapseRepeatedText(stringValue(message.compact_error));
      this.emit({
        type: "compact_failed",
        payload: {
          turnId,
          reason,
          content: reason
            ? `Compacting failed: ${reason}`
            : "Compacting failed."
        }
      });
      return true;
    }
    return false;
  }

  private emitBoundaryUsage(
    message: Record<string, unknown>,
    turnId: string
  ): void {
    const metadata = recordValue(message.compact_metadata);
    const postTokens = numberValue(metadata?.post_tokens);
    const preTokens = numberValue(metadata?.pre_tokens);
    if (postTokens > 0 && turnId) {
      emitUsageUpdated(this.emit, turnId, {
        contextWindow: {
          usedTokens: postTokens,
          ...(preTokens > 0 ? { lastUsedTokens: preTokens } : {})
        }
      });
    }
    void this.emitContextUsageSnapshot(turnId);
  }

  private emitBoundaryCompletion(): void {
    const turnId = this.eventTurnId();
    if (!turnId) {
      return;
    }
    if (!this.inProgress && turnId !== this.commandTurnId) {
      return;
    }
    this.inProgress = false;
    this.emitCompleted(turnId, "Compacting completed.");
  }

  private emitCompleted(turnId: string, content: string): void {
    if (!turnId || this.completedTurnIds.has(turnId)) {
      return;
    }
    this.completedTurnIds.add(turnId);
    this.emit({ type: "compact_completed", payload: { turnId, content } });
  }

  private eventTurnId(): string {
    return this.activeTurnId() || this.commandTurnId;
  }
}

export function collapseRepeatedText(value: string): string {
  const text = value.trim();
  if (text.length < 2) {
    return text;
  }

  for (let repetitions = 2; repetitions <= 4; repetitions += 1) {
    if (text.length % repetitions !== 0) {
      continue;
    }
    const unit = text.slice(0, text.length / repetitions);
    if (unit.repeat(repetitions) === text) {
      return unit;
    }
  }
  return text;
}
