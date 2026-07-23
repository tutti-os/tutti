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
  private readonly onMaybeTitle: (shouldEmit?: () => boolean) => Promise<void>;
  private readonly turns: TurnLifecycle;
  private readonly assistant: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly projection: MessageProjection;
  private readonly compaction: CompactionTracker;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private contextUsageGeneration = 0;
  private activeRootAssistantError = "";

  constructor(options: {
    getProviderSessionId: () => string;
    setProviderSessionId: (value: string) => void;
    onAssistantUuid: (value: string) => void;
    onSessionState: () => void;
    onMaybeTitle: (shouldEmit?: () => boolean) => Promise<void>;
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
    this.emitLifecycleObservation(message, parentToolUseID);
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
      if (isTuttiHostContextUserMessage(message)) {
        return;
      }
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

  private emitLifecycleObservation(
    message: SDKMessage,
    parentToolUseID: string
  ): void {
    const raw = message as unknown as Record<string, unknown>;
    const messageType = stringValue(raw.type);
    const messageSubtype = stringValue(raw.subtype);
    const notificationText =
      messageType === "user"
        ? readUserMessageNotificationText(
            message as { message?: { content?: unknown } }
          )
        : "";
    const taskNotification = notificationText.includes("<task-notification>");
    const systemTaskLifecycle =
      messageType === "system" &&
      (messageSubtype === "task_started" ||
        messageSubtype === "task_progress" ||
        messageSubtype === "task_notification" ||
        messageSubtype === "task_updated");
    const rootContinuationCandidate =
      messageType === "assistant" &&
      !parentToolUseID &&
      (!this.turns.activeId || this.turns.awaitingContinuation);
    const result = messageType === "result";
    if (
      !taskNotification &&
      !systemTaskLifecycle &&
      !rootContinuationCandidate &&
      !result
    ) {
      return;
    }

    this.emit({
      type: "sdk_lifecycle_observed",
      payload: {
        sdkMessageType: messageType,
        ...(messageSubtype ? { sdkMessageSubtype: messageSubtype } : {}),
        ...(taskNotification ? { taskNotification: true } : {}),
        ...(rootContinuationCandidate
          ? { rootContinuationCandidate: true }
          : {}),
        activeTurnIdBefore: this.turns.activeId,
        ...(parentToolUseID ? { parentToolUseId: parentToolUseID } : {}),
        ...(stringValue(raw.task_id)
          ? { taskId: stringValue(raw.task_id) }
          : {}),
        ...(stringValue(raw.agent_id)
          ? { agentId: stringValue(raw.agent_id) }
          : {}),
        ...(stringValue(raw.tool_use_id)
          ? { toolUseId: stringValue(raw.tool_use_id) }
          : {}),
        ...(stringValue(raw.status) ? { status: stringValue(raw.status) } : {}),
        ...(raw.is_error === true ? { sdkResultIsError: true } : {}),
        ...(typeof raw.api_error_status === "number"
          ? { sdkApiErrorStatus: raw.api_error_status }
          : {})
      }
    });
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
    const assistantError = stringValue(
      (message as unknown as Record<string, unknown>).error
    );
    if (assistantError) {
      this.activeRootAssistantError = assistantError;
    }
    const messageId = readSDKAssistantMessageID(message);
    const blocks = contentBlocksFromMessage(message);
    const usedAssistantSegmentIds = new Set<string>();
    for (const block of blocks) {
      this.projection.handleAssistantContentBlock(
        block,
        parentToolUseID,
        messageId,
        usedAssistantSegmentIds,
        Boolean(assistantError)
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
    const activeTurnIdBefore = this.turns.activeId;
    this.turns.activateForUserMessage(readSDKMessageUuid(message));
    if (
      !parentToolUseID &&
      this.turns.activeId &&
      this.turns.activeId !== activeTurnIdBefore
    ) {
      this.contextUsageGeneration += 1;
      this.activeRootAssistantError = "";
    }
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
      is_error?: boolean;
      result?: string;
      api_error_status?: number | null;
      usage?: unknown;
      modelUsage?: unknown;
      total_cost_usd?: unknown;
    };
    this.projection.emitFastModeState(
      (message as unknown as Record<string, unknown>).fast_mode_state
    );
    if (
      this.turns.consumeTimedOutContinuationResult() ||
      this.turns.consumePendingOrphan() ||
      !this.turns.ensureActive("result")
    ) {
      return;
    }
    const turnId = this.turns.activeId;
    const contextUsageGeneration = this.contextUsageGeneration;
    const assistantError = this.activeRootAssistantError;
    this.activeRootAssistantError = "";
    if (this.turns.cancelled) {
      this.turns.settleActive("turn_canceled");
      this.turns.clearCancelled();
    } else if (
      result.subtype === "success" &&
      result.is_error !== true &&
      !assistantError
    ) {
      this.turns.settleActive("turn_completed", { stopReason: "end_turn" });
    } else {
      this.turns.settleActive("turn_failed", {
        error:
          result.errors?.[0] ||
          (result.is_error ? result.result : "") ||
          assistantError ||
          "Claude SDK turn failed",
        ...(assistantError ? { code: assistantError } : {}),
        ...(typeof result.api_error_status === "number"
          ? { apiErrorStatus: result.api_error_status }
          : {})
      });
    }
    void this.emitResultUsage(turnId, contextUsageGeneration, result);
    void this.onMaybeTitle(
      () => this.contextUsageGeneration === contextUsageGeneration
    );
  }

  private async emitResultUsage(
    turnId: string,
    contextUsageGeneration: number,
    result: {
      usage?: unknown;
      modelUsage?: unknown;
      total_cost_usd?: unknown;
    }
  ): Promise<void> {
    const shouldEmit = () =>
      this.contextUsageGeneration === contextUsageGeneration;
    const contextSnapshotResult =
      await this.compaction.emitContextUsageSnapshot(turnId, {
        modelUsage: result.modelUsage,
        shouldEmit
      });
    if (contextSnapshotResult === "unavailable" && shouldEmit()) {
      emitUsageUpdated(this.emit, turnId, {
        usage: result.usage,
        modelUsage: result.modelUsage,
        totalCostUsd: result.total_cost_usd
      });
    }
  }
}

function isTuttiHostContextUserMessage(message: SDKMessage): boolean {
  const userMessage = message as SDKMessage & {
    isSynthetic?: boolean;
    origin?: { kind?: string };
    message?: { content?: unknown };
  };
  if (!userMessage.isSynthetic || userMessage.origin?.kind !== "coordinator") {
    return false;
  }
  return readUserMessageNotificationText(userMessage)
    .trimStart()
    .startsWith("<tutti-host-context");
}
