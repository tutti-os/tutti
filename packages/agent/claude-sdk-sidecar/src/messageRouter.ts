import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  contentBlocksFromMessage,
  isToolUseBlock,
  recordValue
} from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import {
  readQueuedTaskNotificationPrompt,
  readUserMessageNotificationText
} from "./taskNotification.ts";
import {
  readSDKAssistantMessageID,
  readSDKAssistantUuid,
  readSDKMessageUuid,
  readSDKParentToolUseID,
  readSDKSessionID
} from "./sdkMessages.ts";
import { emitUsageUpdated } from "./usage.ts";
import { stringValue } from "./runtimeValues.ts";
import type { AssistantStreamProjector } from "./assistantStream.ts";
import type { CompactionTracker } from "./compaction.ts";
import type { MessageProjection } from "./messageProjection.ts";
import type { ToolActivityProjector } from "./toolActivity.ts";
import type { TurnLifecycle } from "./turnLifecycle.ts";

export class SDKMessageRouter {
  private readonly getProviderSessionId: () => string;
  private readonly setProviderSessionId: (value: string) => void;
  private readonly onAssistantUuid: (value: string) => void;
  private readonly onSessionState: () => void;
  private readonly onMaybeTitle: () => Promise<void>;
  private readonly turns: TurnLifecycle;
  private readonly assistant: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly projection: MessageProjection;
  private readonly compaction: CompactionTracker;
  private readonly emit: ClaudeSDKSidecarEventEmitter;

  constructor(options: {
    getProviderSessionId: () => string;
    setProviderSessionId: (value: string) => void;
    onAssistantUuid: (value: string) => void;
    onSessionState: () => void;
    onMaybeTitle: () => Promise<void>;
    turns: TurnLifecycle;
    assistant: AssistantStreamProjector;
    activities: ToolActivityProjector;
    projection: MessageProjection;
    compaction: CompactionTracker;
    emit: ClaudeSDKSidecarEventEmitter;
  }) {
    this.getProviderSessionId = options.getProviderSessionId;
    this.setProviderSessionId = options.setProviderSessionId;
    this.onAssistantUuid = options.onAssistantUuid;
    this.onSessionState = options.onSessionState;
    this.onMaybeTitle = options.onMaybeTitle;
    this.turns = options.turns;
    this.assistant = options.assistant;
    this.activities = options.activities;
    this.projection = options.projection;
    this.compaction = options.compaction;
    this.emit = options.emit;
  }

  async handle(message: SDKMessage): Promise<void> {
    const parentToolUseID = readSDKParentToolUseID(message);
    const sessionId = readSDKSessionID(message);
    if (sessionId && sessionId !== this.getProviderSessionId()) {
      this.setProviderSessionId(sessionId);
      this.onSessionState();
    }
    const assistantUuid = readSDKAssistantUuid(message);
    if (assistantUuid && !parentToolUseID) {
      this.onAssistantUuid(assistantUuid);
      this.onSessionState();
    }

    const messageType = (message as { type?: string }).type;
    if (messageType === "attachment") {
      const prompt = readQueuedTaskNotificationPrompt(
        message as unknown as Record<string, unknown>
      );
      if (prompt) {
        this.activities.handleTaskNotificationFromText(prompt);
      }
      return;
    }

    if (message.type === "system") {
      this.projection.handleSystemMessage(
        message as unknown as Record<string, unknown>
      );
      return;
    }

    if (message.type === "stream_event") {
      this.handleStreamEvent(message, parentToolUseID);
      return;
    }

    if (message.type === "assistant") {
      this.handleAssistant(message, parentToolUseID);
      return;
    }

    if (message.type === "user") {
      this.handleUser(message, parentToolUseID);
      return;
    }

    if (message.type === "tool_progress") {
      if (!this.turns.ensureActive("tool_progress")) {
        return;
      }
      this.activities.handleToolProgress(
        message as Record<string, unknown>,
        parentToolUseID
      );
      return;
    }

    if (message.type === "result") {
      await this.handleResult(message, parentToolUseID);
    }
  }

  private handleStreamEvent(
    message: SDKMessage,
    parentToolUseID: string
  ): void {
    if (!this.turns.ensureActive("stream_event")) {
      return;
    }
    const event = (message as { event?: unknown }).event;
    if (!event || typeof event !== "object") {
      return;
    }
    const streamEvent = event as {
      type?: string;
      index?: number;
      content_block?: Record<string, unknown>;
      message?: Record<string, unknown>;
      delta?: { type?: string; text?: string; thinking?: string };
      usage?: unknown;
    };
    if (streamEvent.type === "message_start") {
      if (!parentToolUseID) {
        this.assistant.setMessageBase(stringValue(streamEvent.message?.id));
      }
      return;
    }
    if (streamEvent.type === "content_block_start") {
      this.projection.handleContentBlockStart(streamEvent, parentToolUseID);
      return;
    }
    if (streamEvent.type === "content_block_stop") {
      this.projection.handleContentBlockStop(streamEvent);
      return;
    }
    if (streamEvent.type === "message_delta") {
      const usage = parentToolUseID
        ? undefined
        : recordValue(streamEvent.usage);
      if (usage) {
        this.emit({
          type: "usage_updated",
          payload: { turnId: this.turns.activeId, usage }
        });
      }
      return;
    }
    if (streamEvent.type !== "content_block_delta" || !streamEvent.delta) {
      return;
    }
    const delta = streamEvent.delta;
    if (delta.type === "input_json_delta") {
      this.activities.handleToolInputDelta(
        streamEvent.index,
        (delta as { partial_json?: unknown }).partial_json
      );
      return;
    }
    if (parentToolUseID) {
      return;
    }
    if (delta.type === "text_delta" && delta.text) {
      this.assistant.appendDelta(streamEvent.index, "assistant", delta.text);
    }
    if (delta.type === "thinking_delta" && delta.thinking) {
      this.assistant.appendDelta(streamEvent.index, "thinking", delta.thinking);
    }
  }

  private handleAssistant(message: SDKMessage, parentToolUseID: string): void {
    if (parentToolUseID) {
      this.handleNestedAssistant(message, parentToolUseID);
      return;
    }
    if (!this.turns.ensureActive("assistant")) {
      return;
    }
    const messageId = readSDKAssistantMessageID(message);
    const blocks = contentBlocksFromMessage(message);
    const usedAssistantSegmentIds = new Set<string>();
    for (const block of blocks) {
      this.projection.handleAssistantContentBlock(
        block,
        parentToolUseID,
        messageId,
        usedAssistantSegmentIds
      );
    }
    this.projection.emitGoalStatusFromBlocks(blocks);
  }

  private handleNestedAssistant(
    message: SDKMessage,
    parentToolUseID: string
  ): void {
    for (const block of contentBlocksFromMessage(message)) {
      if (isToolUseBlock(block)) {
        this.activities.upsertToolUse(
          block,
          undefined,
          "tool_updated",
          parentToolUseID
        );
      }
    }
    if (
      this.activities.isNestedDelegatedTaskTerminalAssistant(message) &&
      !this.activities.hasUnsettledChildWork(parentToolUseID)
    ) {
      this.activities.completeDelegatedTaskFromParentMessage(parentToolUseID, {
        status: "completed",
        summary:
          this.activities.extractAssistantTextFromMessage(message) ||
          "Subagent task completed."
      });
    }
  }

  private handleUser(message: SDKMessage, parentToolUseID: string): void {
    const notificationText = readUserMessageNotificationText(
      message as { message?: { content?: unknown } }
    );
    if (notificationText.includes("<task-notification>")) {
      this.activities.handleTaskNotificationFromText(notificationText);
    }
    this.turns.activateForUserMessage(readSDKMessageUuid(message));
    const blocks = contentBlocksFromMessage(message);
    if (
      this.turns.pendingOrphans > 0 &&
      blocks.some((block) => block.type === "text")
    ) {
      this.turns.clearPendingOrphans();
    }
    for (const block of blocks) {
      this.activities.handleUserContentBlock(block, parentToolUseID);
    }
    this.projection.emitGoalStatusFromBlocks(blocks);
  }

  private async handleResult(
    message: SDKMessage,
    parentToolUseID: string
  ): Promise<void> {
    if (parentToolUseID) {
      this.activities.completeDelegatedTaskFromResultMessage(
        parentToolUseID,
        message
      );
      return;
    }
    const result = message as {
      subtype?: string;
      errors?: string[];
      usage?: unknown;
      modelUsage?: unknown;
      total_cost_usd?: unknown;
    };
    this.projection.emitFastModeState(
      (message as unknown as Record<string, unknown>).fast_mode_state
    );
    if (
      this.turns.consumePendingOrphan() ||
      !this.turns.ensureActive("result")
    ) {
      return;
    }
    emitUsageUpdated(this.emit, this.turns.activeId, {
      usage: result.usage,
      modelUsage: result.modelUsage,
      totalCostUsd: result.total_cost_usd
    });
    await this.compaction.emitContextUsageSnapshot(this.turns.activeId, {
      modelUsage: result.modelUsage
    });
    await this.onMaybeTitle();
    if (this.turns.cancelled) {
      this.turns.settleActive("turn_canceled");
      this.turns.clearCancelled();
      return;
    }
    if (result.subtype === "success") {
      this.turns.settleActive("turn_completed", { stopReason: "end_turn" });
      return;
    }
    this.turns.settleActive("turn_failed", {
      error: result.errors?.[0] ?? "Claude SDK turn failed"
    });
  }
}
