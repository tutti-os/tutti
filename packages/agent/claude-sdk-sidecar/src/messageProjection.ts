import {
  commandEntries,
  goalStateFromContentBlocks,
  isThinkingBlock,
  isToolUseBlock,
  recordValue,
  speedFromFastModeState
} from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import type { AssistantStreamProjector } from "./assistantStream.ts";
import type { CompactionTracker } from "./compaction.ts";
import type { ToolActivityProjector } from "./toolActivity.ts";
import type { TurnLifecycle } from "./turnLifecycle.ts";

export class MessageProjection {
  private readonly providerSessionId: () => string;
  private readonly turns: TurnLifecycle;
  private readonly assistant: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly compaction: CompactionTracker;
  private readonly emit: ClaudeSDKSidecarEventEmitter;

  constructor(options: {
    providerSessionId: () => string;
    turns: TurnLifecycle;
    assistant: AssistantStreamProjector;
    activities: ToolActivityProjector;
    compaction: CompactionTracker;
    emit: ClaudeSDKSidecarEventEmitter;
  }) {
    this.providerSessionId = options.providerSessionId;
    this.turns = options.turns;
    this.assistant = options.assistant;
    this.activities = options.activities;
    this.compaction = options.compaction;
    this.emit = options.emit;
  }

  handleSystemMessage(message: Record<string, unknown>): void {
    this.emitFastModeStateFromMessage(message);
    const subtype = stringValue(message.subtype);
    if (
      subtype === "task_started" ||
      subtype === "task_progress" ||
      subtype === "task_notification"
    ) {
      this.activities.handleTaskSystemMessage(subtype, message);
      return;
    }
    if (subtype === "task_updated") {
      this.handleTaskUpdated(message);
      return;
    }
    if (subtype === "init" || subtype === "commands_changed") {
      const commands = commandEntries(message.commands);
      if (commands.length > 0 || Array.isArray(message.commands)) {
        this.emit({
          type: "commands_updated",
          payload: {
            providerSessionId: this.providerSessionId(),
            commands
          }
        });
      }
      return;
    }
    this.compaction.handleSystemMessage(subtype, message);
  }

  emitFastModeState(state: unknown): void {
    const rawState = stringValue(state);
    if (!rawState) {
      return;
    }
    const payload: Record<string, unknown> = { state: rawState };
    const speed = speedFromFastModeState(rawState);
    if (speed) {
      payload.speed = speed;
    }
    this.emit({ type: "speed_updated", payload });
  }

  handleContentBlockStart(
    streamEvent: {
      index?: number;
      content_block?: Record<string, unknown>;
    },
    parentToolUseID = ""
  ): void {
    const block = streamEvent.content_block;
    if (!block) {
      return;
    }
    if (!parentToolUseID && block.type === "text") {
      this.assistant.start(streamEvent.index, "assistant");
      return;
    }
    if (!parentToolUseID && block.type === "thinking") {
      this.assistant.start(streamEvent.index, "thinking");
      return;
    }
    if (isToolUseBlock(block)) {
      this.activities.upsertToolUse(
        block,
        streamEvent.index,
        "tool_started",
        parentToolUseID
      );
    }
  }

  handleContentBlockStop(streamEvent: { index?: number }): void {
    if (typeof streamEvent.index !== "number") {
      return;
    }
    if (!this.assistant.completeIndex(streamEvent.index)) {
      this.activities.completeToolIndex(streamEvent.index);
    }
  }

  handleAssistantContentBlock(
    block: Record<string, unknown>,
    parentToolUseID = "",
    messageId = "",
    usedSegmentIds = new Set<string>(),
    failed = false
  ): void {
    if (isThinkingBlock(block)) {
      if (!parentToolUseID) {
        this.assistant.completeContent(
          "thinking",
          messageId,
          stringValue(block.thinking),
          usedSegmentIds
        );
      }
      return;
    }
    if (block.type === "text") {
      if (!parentToolUseID) {
        const content = stringValue(block.text);
        if (failed) {
          this.assistant.failContent(
            "assistant",
            messageId,
            content,
            usedSegmentIds
          );
        } else {
          this.assistant.completeContent(
            "assistant",
            messageId,
            content,
            usedSegmentIds
          );
        }
      }
      return;
    }
    if (isToolUseBlock(block)) {
      this.activities.upsertToolUse(
        block,
        undefined,
        "tool_updated",
        parentToolUseID
      );
    }
  }

  emitGoalStatusFromBlocks(
    blocks: ReadonlyArray<Record<string, unknown>>
  ): void {
    const goal = goalStateFromContentBlocks(blocks);
    if (!goal) {
      return;
    }
    this.emit({
      type: "goal_updated",
      payload: {
        turnId: this.turns.activeId,
        updateType: "thread_goal_update",
        goal
      }
    });
  }

  private emitFastModeStateFromMessage(message: Record<string, unknown>): void {
    if (Object.hasOwn(message, "fast_mode_state")) {
      this.emitFastModeState(message.fast_mode_state);
    }
  }

  private handleTaskUpdated(message: Record<string, unknown>): void {
    const patch = recordValue(message.patch);
    const status = stringValue(patch?.status);
    if (status !== "completed" && status !== "failed" && status !== "killed") {
      return;
    }
    this.activities.handleTaskSystemMessage("task_notification", {
      task_id: stringValue(message.task_id),
      tool_use_id: stringValue(message.tool_use_id),
      status: status === "killed" ? "stopped" : status,
      summary:
        stringValue(patch?.description) ||
        stringValue(message.summary) ||
        stringValue(message.description)
    });
  }
}
