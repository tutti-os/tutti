import {
  numberValue,
  parseJSONObject,
  recordValue,
  toolPayload,
  type ToolState
} from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import {
  isDiffToolResponse,
  mergeToolResult,
  taskStepFromToolPayload
} from "./sdkMessages.ts";
import { stringValue } from "./runtimeValues.ts";

export type ToolTerminalListener = (
  tool: ToolState,
  payload: Record<string, unknown>
) => void;

export class ToolEventProjector {
  private readonly toolByIndex = new Map<number, ToolState>();
  private readonly toolByID = new Map<string, ToolState>();
  private readonly toolHookResultByID = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly resolveTurnId: (tool: ToolState) => string;
  private readonly onTerminal: ToolTerminalListener;
  private readonly emit: ClaudeSDKSidecarEventEmitter;

  constructor(
    resolveTurnId: (tool: ToolState) => string,
    onTerminal: ToolTerminalListener,
    emit: ClaudeSDKSidecarEventEmitter
  ) {
    this.resolveTurnId = resolveTurnId;
    this.onTerminal = onTerminal;
    this.emit = emit;
  }

  reset(): void {
    this.toolByIndex.clear();
    this.toolByID.clear();
    this.toolHookResultByID.clear();
  }

  completeIndex(index: number): boolean {
    const tool = this.toolByIndex.get(index);
    if (!tool) {
      return false;
    }
    this.emitToolEvent("tool_updated", tool, "streaming");
    return true;
  }

  parentToolUseID(toolUseID: string): string {
    return stringValue(this.toolByID.get(toolUseID)?.parentToolUseId);
  }

  hasPendingChildResults(parentToolUseID: string): boolean {
    for (const tool of this.toolByID.values()) {
      if (tool.parentToolUseId === parentToolUseID) {
        return true;
      }
    }
    return false;
  }

  handleInputDelta(index: unknown, partialJSON: unknown): void {
    if (typeof index !== "number" || typeof partialJSON !== "string") {
      return;
    }
    const tool = this.toolByIndex.get(index);
    if (!tool) {
      return;
    }
    tool.partialInputJson += partialJSON;
    const parsed = parseJSONObject(tool.partialInputJson);
    if (parsed) {
      tool.input = parsed;
    }
    this.emitToolEvent("tool_updated", tool, "streaming");
  }

  handleUserContentBlock(
    block: Record<string, unknown>,
    parentToolUseID = ""
  ): void {
    if (block.type !== "tool_result") {
      return;
    }
    const toolUseID = stringValue(block.tool_use_id);
    if (!toolUseID) {
      return;
    }
    const tool = this.toolByID.get(toolUseID) ?? {
      id: toolUseID,
      name: "",
      input: {},
      partialInputJson: "",
      started: true,
      ...(parentToolUseID ? { parentToolUseId: parentToolUseID } : {})
    };
    if (parentToolUseID && !tool.parentToolUseId) {
      tool.parentToolUseId = parentToolUseID;
    }
    const failed = block.is_error === true;
    const result = failed
      ? block
      : mergeToolResult(block, this.toolHookResultByID.get(toolUseID));
    this.emitToolEvent(
      failed ? "tool_failed" : "tool_completed",
      tool,
      failed ? "failed" : "completed",
      result
    );
    this.toolHookResultByID.delete(toolUseID);
    this.toolByID.delete(toolUseID);
    for (const [index, indexedTool] of this.toolByIndex) {
      if (indexedTool.id === toolUseID) {
        this.toolByIndex.delete(index);
      }
    }
  }

  handlePostToolUseHook(
    input: unknown,
    toolUseID?: string
  ): { continue: boolean } {
    const hookInput = recordValue(input);
    if (!hookInput || hookInput.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }
    const toolID =
      stringValue(toolUseID) ||
      stringValue(hookInput.tool_use_id) ||
      stringValue(hookInput.toolUseID);
    const toolResponse = recordValue(hookInput.tool_response);
    if (!toolID || !isDiffToolResponse(toolResponse)) {
      return { continue: true };
    }
    const toolName =
      stringValue(hookInput.tool_name) ||
      this.toolByID.get(toolID)?.name ||
      "Claude Code tool";
    if (toolName !== "Edit" && toolName !== "Write") {
      return { continue: true };
    }
    const hookResult = {
      _meta: {
        claudeCode: {
          toolName,
          toolResponse
        }
      },
      tool_response: toolResponse
    };
    this.toolHookResultByID.set(toolID, hookResult);
    const hookTool = this.toolByID.get(toolID) ?? {
      id: toolID,
      name: toolName,
      input: recordValue(hookInput.tool_input) ?? {},
      partialInputJson: "",
      started: true,
      parentToolUseId: stringValue(hookInput.parent_tool_use_id)
    };
    this.emitToolEvent("tool_completed", hookTool, "completed", hookResult);
    return { continue: true };
  }

  handleProgress(message: Record<string, unknown>, parentToolUseID = ""): void {
    const toolUseID = stringValue(message.tool_use_id);
    const tool = toolUseID ? this.toolByID.get(toolUseID) : undefined;
    if (!tool) {
      return;
    }
    if (parentToolUseID && !tool.parentToolUseId) {
      tool.parentToolUseId = parentToolUseID;
    }
    const elapsedMS = numberValue(message.elapsed_ms);
    this.emitToolEvent("tool_updated", tool, "streaming", {
      progress: message.progress,
      ...(elapsedMS > 0 ? { elapsedMs: elapsedMS } : {})
    });
  }

  upsert(
    block: Record<string, unknown>,
    index: number | undefined,
    eventType: "tool_started" | "tool_updated",
    parentToolUseID = ""
  ): void {
    const id = stringValue(block.id);
    if (!id) {
      return;
    }
    const input = recordValue(block.input) ?? {};
    const existing = this.toolByID.get(id);
    const tool: ToolState = existing ?? {
      id,
      name: stringValue(block.name),
      input,
      partialInputJson: "",
      started: false,
      ...(parentToolUseID ? { parentToolUseId: parentToolUseID } : {})
    };
    tool.name = stringValue(block.name) || tool.name;
    if (parentToolUseID && !tool.parentToolUseId) {
      tool.parentToolUseId = parentToolUseID;
    }
    if (Object.keys(input).length > 0) {
      tool.input = input;
    }
    this.toolByID.set(id, tool);
    if (typeof index === "number") {
      this.toolByIndex.set(index, tool);
    }
    if (!tool.started || eventType === "tool_started") {
      tool.started = true;
      this.emitToolEvent("tool_started", tool, "streaming");
      return;
    }
    this.emitToolEvent("tool_updated", tool, "streaming");
  }

  private emitToolEvent(
    type: "tool_started" | "tool_updated" | "tool_completed" | "tool_failed",
    tool: ToolState,
    status: "streaming" | "completed" | "failed",
    result?: Record<string, unknown>
  ): void {
    const payload = toolPayload(this.resolveTurnId(tool), tool, status, result);
    if (type === "tool_completed" || type === "tool_failed") {
      this.appendParentTaskStep(tool, payload);
      this.onTerminal(tool, payload);
    }
    this.emit({ type, payload });
  }

  private appendParentTaskStep(
    tool: ToolState,
    payload: Record<string, unknown>
  ): void {
    const parentToolUseID = stringValue(tool.parentToolUseId);
    if (!parentToolUseID) {
      return;
    }
    const parent = this.toolByID.get(parentToolUseID);
    if (!parent) {
      return;
    }
    const step = taskStepFromToolPayload(payload);
    const stepID = stringValue(step.toolUseId) || stringValue(step.id);
    const existing = parent.steps ?? [];
    const index = existing.findIndex((candidate) => {
      const item = recordValue(candidate);
      return (
        item &&
        stepID &&
        (stringValue(item.toolUseId) === stepID ||
          stringValue(item.id) === stepID)
      );
    });
    if (index >= 0) {
      existing[index] = step;
    } else {
      existing.push(step);
    }
    parent.steps = existing;
  }
}
