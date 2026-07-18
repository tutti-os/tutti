import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  contentBlocksFromMessage,
  recordValue,
  type ToolState
} from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import {
  parseTaskNotification,
  taskNotificationToSystemMessage
} from "./taskNotification.ts";
import type {
  DelegatedTaskState,
  DelegatedTaskStatus
} from "./toolActivityTypes.ts";
import { ToolEventProjector } from "./toolEvents.ts";
import { TaskPlanTracker } from "./taskPlan.ts";

export class ToolActivityProjector {
  private readonly tools: ToolEventProjector;
  private readonly taskPlan: TaskPlanTracker;
  private readonly delegatedTasksByParentToolUseID = new Map<
    string,
    DelegatedTaskState
  >();
  private readonly delegatedParentByAgentID = new Map<string, string>();
  private readonly delegatedParentByTaskID = new Map<string, string>();
  private readonly activeTurnId: () => string;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly onFinalDelegatedTaskSettling: () => void;
  private readonly lastTurnId: () => string;

  constructor(
    activeTurnId: () => string,
    emit: ClaudeSDKSidecarEventEmitter,
    onFinalDelegatedTaskSettling: () => void = () => {},
    lastTurnId: () => string = activeTurnId
  ) {
    this.activeTurnId = activeTurnId;
    this.emit = emit;
    this.onFinalDelegatedTaskSettling = onFinalDelegatedTaskSettling;
    this.lastTurnId = lastTurnId;
    this.taskPlan = new TaskPlanTracker(activeTurnId, emit);
    this.tools = new ToolEventProjector(
      (tool) => this.resolveToolEventTurnId(tool),
      (tool, payload) =>
        this.rememberDelegatedTaskFromToolPayload(tool, payload),
      emit
    );
  }

  resetTurnScratch(): void {
    this.tools.reset();
    this.taskPlan.reset();
  }

  completeToolIndex(index: number): boolean {
    return this.tools.completeIndex(index);
  }

  resolveInteractiveTurnId(toolUseID: string): string {
    const parentToolUseID = this.tools.parentToolUseID(toolUseID);
    return parentToolUseID
      ? (this.delegatedTasksByParentToolUseID.get(parentToolUseID)?.turnId ??
          "")
      : "";
  }

  runningDelegatedTurnId(): string {
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (task.status === "running" && task.turnId) {
        return task.turnId;
      }
    }
    return "";
  }

  latestDelegatedTurnId(): string {
    let latest = "";
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (task.turnId) {
        latest = task.turnId;
      }
    }
    return latest;
  }

  resolveDelegatedTaskIdForStop(
    taskId: string,
    parentToolUseId: string
  ): string {
    // Callers may only hold one identifier, and the daemon's child key can be
    // the SDK task id, the agent id, or the launching tool use id; try all.
    const parentByAlias = taskId
      ? this.delegatedParentByAlias(taskId, taskId)
      : "";
    const task = parentByAlias
      ? this.delegatedTasksByParentToolUseID.get(parentByAlias)
      : this.delegatedTasksByParentToolUseID.get(parentToolUseId || taskId);
    return task?.status === "running" ? (task.taskId ?? "") : "";
  }

  handleTaskNotificationFromText(text: string): void {
    const parsed = parseTaskNotification(text);
    if (!parsed) {
      return;
    }
    this.handleTaskSystemMessage(
      "task_notification",
      taskNotificationToSystemMessage(parsed)
    );
  }

  handleTaskSystemMessage(
    subtype: "task_started" | "task_progress" | "task_notification",
    message: Record<string, unknown>
  ): void {
    // task_notification is included so a terminal notice for a task launched
    // before a sidecar restart (reported e.g. as stopped on the next prompt)
    // still settles a card instead of being dropped by the fresh instance.
    const task =
      this.resolveDelegatedTaskFromMessage(message) ??
      (subtype === "task_started" || subtype === "task_notification"
        ? this.rememberBackgroundTask(message)
        : undefined);
    if (!task) {
      return;
    }
    const taskId = stringValue(message.task_id) || stringValue(message.taskId);
    if (taskId && !task.taskId) {
      task.taskId = taskId;
      this.delegatedParentByTaskID.set(taskId, task.parentToolUseId);
    }
    const description =
      stringValue(message.description) || stringValue(message.summary);
    if (description && !task.description) {
      task.description = description;
    }
    if (subtype === "task_notification") {
      if (task.status !== "running") {
        return;
      }
      const status = delegatedTaskStatus(message.status);
      // A user-initiated stop needs no model follow-up, so it must not open a
      // synthetic continuation turn (which would time out and interrupt).
      if (status !== "stopped") {
        this.prepareDelegatedTaskTerminal(task);
      }
      task.status = status;
      this.emitDelegatedTaskLifecycleEvent("task_completed", task, message);
      this.emitDelegatedTaskParentUpdate(task, message);
      return;
    }
    if (subtype === "task_progress" && task.status !== "running") {
      // A trailing progress event delivered after the task's own completion
      // must not resurrect the task and bump the running count; only an
      // explicit task_started may restart a settled task.
      return;
    }
    task.status = "running";
    this.emitDelegatedTaskLifecycleEvent(
      subtype === "task_started" ? "task_started" : "task_progress",
      task,
      message
    );
  }

  handleToolInputDelta(index: unknown, partialJSON: unknown): void {
    this.tools.handleInputDelta(index, partialJSON);
  }

  handleUserContentBlock(
    block: Record<string, unknown>,
    parentToolUseID = ""
  ): void {
    this.tools.handleUserContentBlock(block, parentToolUseID);
  }

  async handlePostToolUseHook(
    input: unknown,
    toolUseID?: string
  ): Promise<{ continue: boolean }> {
    return this.tools.handlePostToolUseHook(input, toolUseID);
  }

  async handleTaskLifecycleHook(
    input: unknown
  ): Promise<{ continue: boolean }> {
    const hookInput = recordValue(input);
    if (!hookInput) {
      return { continue: true };
    }
    const taskID = stringValue(hookInput.task_id);
    if (!taskID) {
      return { continue: true };
    }
    if (hookInput.hook_event_name === "TaskCreated") {
      const subject = stringValue(hookInput.task_subject);
      if (
        !this.taskPlan.create(
          taskID,
          subject,
          stringValue(hookInput.task_description)
        )
      ) {
        return { continue: true };
      }
      this.bindDelegatedTaskIDFromHook(taskID, hookInput);
      return { continue: true };
    }
    if (hookInput.hook_event_name === "TaskCompleted") {
      this.bindDelegatedTaskIDFromHook(taskID, hookInput);
      this.emitDelegatedTaskCompletedFromHook(hookInput);
      this.taskPlan.complete(taskID);
    }
    return { continue: true };
  }

  private bindDelegatedTaskIDFromHook(
    taskID: string,
    hookInput: Record<string, unknown>
  ): void {
    const task = this.resolveDelegatedTaskFromMessage(hookInput, {
      allowRunningFallback: false
    });
    if (!task || task.taskId) {
      return;
    }
    task.taskId = taskID;
    this.delegatedParentByTaskID.set(taskID, task.parentToolUseId);
    task.subject = stringValue(hookInput.task_subject) || task.subject;
    task.description =
      stringValue(hookInput.task_description) || task.description;
  }

  private emitDelegatedTaskCompletedFromHook(
    hookInput: Record<string, unknown>
  ): void {
    const task = this.resolveDelegatedTaskFromMessage(hookInput);
    if (!task) {
      return;
    }
    const status = delegatedTaskStatus(hookInput.status);
    if (status !== "stopped") {
      this.prepareDelegatedTaskTerminal(task);
    }
    const taskId = stringValue(hookInput.task_id) || task.taskId;
    if (taskId && !task.taskId) {
      task.taskId = taskId;
      this.delegatedParentByTaskID.set(taskId, task.parentToolUseId);
    }
    task.status = status;
    task.subject = stringValue(hookInput.task_subject) || task.subject;
    task.description =
      stringValue(hookInput.task_description) || task.description;
    const summary =
      stringValue(hookInput.summary) ||
      stringValue(hookInput.task_summary) ||
      stringValue(hookInput.task_result) ||
      task.description ||
      task.subject;
    const message: Record<string, unknown> = {
      ...hookInput,
      task_id: task.taskId,
      taskId: task.taskId,
      status: task.status,
      ...(task.description ? { description: task.description } : {}),
      ...(summary ? { summary } : {})
    };
    this.emitDelegatedTaskLifecycleEvent("task_completed", task, message);
    this.emitDelegatedTaskParentUpdate(task, message);
  }

  completeDelegatedTaskFromResultMessage(
    parentToolUseID: string,
    message: SDKMessage
  ): void {
    const result = message as Record<string, unknown>;
    const summary = stringValue(result.summary) || stringValue(result.result);
    this.completeDelegatedTaskFromParentMessage(parentToolUseID, {
      ...result,
      ...(summary ? { summary } : {}),
      status: delegatedTaskStatus(result.subtype ?? result.status)
    });
  }

  completeDelegatedTaskFromParentMessage(
    parentToolUseID: string,
    message: Record<string, unknown>
  ): void {
    const task = this.resolveDelegatedTaskFromMessage(
      { ...message, parentToolUseId: parentToolUseID },
      { allowRunningFallback: false }
    );
    if (!task || task.status !== "running") {
      return;
    }
    const status = delegatedTaskStatus(message.status);
    if (status !== "stopped") {
      this.prepareDelegatedTaskTerminal(task);
    }
    task.status = status;
    this.emitDelegatedTaskLifecycleEvent("task_completed", task, message);
    this.emitDelegatedTaskParentUpdate(task, message);
  }

  isNestedDelegatedTaskTerminalAssistant(message: SDKMessage): boolean {
    const nested = recordValue((message as { message?: unknown }).message);
    const stopReason =
      stringValue(nested?.stop_reason) ||
      stringValue((message as Record<string, unknown>).stop_reason);
    if (stopReason !== "end_turn") {
      return false;
    }
    return contentBlocksFromMessage(message).some(
      (block) =>
        block.type === "text" && Boolean(stringValue(block.text)?.trim())
    );
  }

  extractAssistantTextFromMessage(message: SDKMessage): string {
    return contentBlocksFromMessage(message)
      .flatMap((block) =>
        block.type === "text" && stringValue(block.text)
          ? [stringValue(block.text) as string]
          : []
      )
      .join("\n")
      .trim();
  }

  handleToolProgress(
    message: Record<string, unknown>,
    parentToolUseID = ""
  ): void {
    this.tools.handleProgress(message, parentToolUseID);
  }

  upsertToolUse(
    block: Record<string, unknown>,
    index: number | undefined,
    eventType: "tool_started" | "tool_updated",
    parentToolUseID = ""
  ): void {
    this.tools.upsert(block, index, eventType, parentToolUseID);
  }

  private resolveToolEventTurnId(tool: ToolState): string {
    if (this.activeTurnId()) {
      return this.activeTurnId();
    }
    // Child-stream tool events can arrive after the launching turn settled;
    // attribute them to the turn of the delegated task they belong to.
    const parentToolUseID = stringValue(tool.parentToolUseId);
    if (parentToolUseID) {
      const task = this.delegatedTasksByParentToolUseID.get(parentToolUseID);
      if (task?.turnId) {
        return task.turnId;
      }
    }
    return "";
  }

  private rememberDelegatedTaskFromToolPayload(
    tool: ToolState,
    payload: Record<string, unknown>
  ): void {
    const metadata = recordValue(payload.metadata);
    // The launch result text sets subagentAsync; nested launches may stream
    // without a locally known tool name, so callType alone cannot gate here.
    if (metadata?.subagentAsync !== true) {
      return;
    }
    const parentToolUseId = stringValue(payload.toolCallId) || tool.id;
    if (!parentToolUseId) {
      return;
    }
    const agentId =
      stringValue(metadata.subagentAgentId) || stringValue(metadata.agentId);
    const outputFile =
      stringValue(metadata.subagentOutputFile) ||
      stringValue(metadata.outputFile);
    const launchingTask = this.delegatedTasksByParentToolUseID.get(
      stringValue(tool.parentToolUseId)
    );
    const task: DelegatedTaskState = {
      parentToolUseId,
      turnId:
        stringValue(payload.turnId) ||
        this.activeTurnId() ||
        launchingTask?.turnId ||
        "",
      input: recordValue(payload.input) ?? { ...tool.input },
      ...(agentId ? { agentId } : {}),
      ...(outputFile ? { outputFile } : {}),
      status: "running",
      ...(launchingTask
        ? { parentTaskToolUseId: launchingTask.parentToolUseId }
        : {})
    };
    this.delegatedTasksByParentToolUseID.set(parentToolUseId, task);
    if (agentId) {
      this.delegatedParentByAgentID.set(agentId, parentToolUseId);
    }
  }

  // Background launches the launch-result path does not register (most
  // importantly `run_in_background` Bash) still announce themselves through
  // the SDK task system. Registering them here puts them on the same
  // delegated-task rails as background subagents, so they gate the root turn,
  // show up as child sessions, and can be stopped individually — instead of
  // running invisibly after the turn settled.
  private rememberBackgroundTask(
    message: Record<string, unknown>
  ): DelegatedTaskState | undefined {
    const parentToolUseId =
      stringValue(message.tool_use_id) || stringValue(message.toolCallId);
    const taskId = stringValue(message.task_id) || stringValue(message.taskId);
    if (!parentToolUseId || !taskId) {
      // Without a launching tool use id this could be a racing alias for a
      // not-yet-registered subagent launch; binding it here would poison the
      // alias maps, so leave it for the launch result to register.
      return undefined;
    }
    const task: DelegatedTaskState = {
      parentToolUseId,
      // Background task_started frequently arrives after the launching
      // provider turn already settled; fall back to that turn so lifecycle
      // events are not dropped for lack of a turn id.
      turnId: this.activeTurnId() || this.lastTurnId(),
      input: {},
      taskId,
      status: "running"
    };
    this.delegatedTasksByParentToolUseID.set(parentToolUseId, task);
    this.delegatedParentByTaskID.set(taskId, parentToolUseId);
    return task;
  }

  private resolveDelegatedTaskFromMessage(
    message: Record<string, unknown>,
    options: { allowRunningFallback?: boolean } = {}
  ): DelegatedTaskState | undefined {
    const taskId = stringValue(message.task_id) || stringValue(message.taskId);
    const agentId =
      stringValue(message.agentId) ||
      stringValue(message.agent_id) ||
      stringValue(message.agentID);
    const explicitParentToolUseId =
      stringValue(message.parentToolUseId) ||
      stringValue(message.parent_tool_use_id) ||
      stringValue(message.tool_use_id) ||
      stringValue(message.toolCallId) ||
      stringValue(message.callId);
    if (explicitParentToolUseId) {
      return this.delegatedTasksByParentToolUseID.get(explicitParentToolUseId);
    }
    const parentToolUseId = this.delegatedParentByAlias(taskId, agentId);
    if (parentToolUseId) {
      return this.delegatedTasksByParentToolUseID.get(parentToolUseId);
    }
    if (options.allowRunningFallback === false) {
      return undefined;
    }
    if ((taskId || agentId) && this.hasDelegatedTaskAliases()) {
      // An unresolved task/agent id usually belongs to a delegated task whose
      // launch has not been observed yet. Binding it to "the only running"
      // task would poison the alias maps for concurrent launches, so drop the
      // event and let a later resolvable event settle that task.
      return undefined;
    }
    const activeTasks = [
      ...this.delegatedTasksByParentToolUseID.values()
    ].filter(
      (task) => task.turnId === this.activeTurnId() && task.status === "running"
    );
    if (activeTasks.length === 1) {
      return activeTasks[0];
    }
    const allRunningTasks = [
      ...this.delegatedTasksByParentToolUseID.values()
    ].filter((task) => task.status === "running");
    return allRunningTasks.length === 1 ? allRunningTasks[0] : undefined;
  }

  private delegatedParentByAlias(taskId: string, agentId: string): string {
    // Claude Code hooks and task notifications frequently carry the agent id
    // in task_id, so each alias is matched against both maps.
    for (const alias of [taskId, agentId]) {
      if (!alias) {
        continue;
      }
      const parent =
        this.delegatedParentByTaskID.get(alias) ||
        this.delegatedParentByAgentID.get(alias);
      if (parent) {
        return parent;
      }
    }
    return "";
  }

  private hasDelegatedTaskAliases(): boolean {
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (task.agentId || task.taskId) {
        return true;
      }
    }
    return false;
  }

  private hasRunningChildDelegatedTasks(parentToolUseId: string): boolean {
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (
        task.parentTaskToolUseId === parentToolUseId &&
        task.status === "running"
      ) {
        return true;
      }
    }
    return false;
  }

  hasUnsettledChildWork(parentToolUseId: string): boolean {
    return (
      this.tools.hasPendingChildResults(parentToolUseId) ||
      this.hasRunningChildDelegatedTasks(parentToolUseId)
    );
  }

  private prepareDelegatedTaskTerminal(task: DelegatedTaskState): void {
    if (task.status !== "running") {
      return;
    }
    const running = [...this.delegatedTasksByParentToolUseID.values()].filter(
      (candidate) => candidate.status === "running"
    );
    if (running.length === 1 && running[0] === task) {
      this.onFinalDelegatedTaskSettling();
    }
  }

  private emitDelegatedTaskParentUpdate(
    task: DelegatedTaskState,
    message: Record<string, unknown>
  ): void {
    const turnId = task.turnId || this.activeTurnId();
    if (!turnId) {
      return;
    }
    task.turnId = turnId;
    const summary =
      delegatedTaskSummaryFromMessage(message) || "Subagent task completed.";
    const usage = recordValue(message.usage);
    const metadata: Record<string, unknown> = {
      adapter: "claude-agent-sdk",
      toolName: "Agent",
      async: true,
      subagentAsync: true,
      taskStatus: task.status,
      subagentStatus: task.status,
      ...(task.taskId ? { taskId: task.taskId } : {}),
      ...(task.agentId
        ? { agentId: task.agentId, subagentAgentId: task.agentId }
        : {}),
      ...(task.outputFile
        ? { outputFile: task.outputFile, subagentOutputFile: task.outputFile }
        : {})
    };
    this.emit({
      type: task.status === "failed" ? "tool_failed" : "tool_completed",
      payload: {
        turnId,
        toolCallId: task.parentToolUseId,
        callId: task.parentToolUseId,
        toolName: "Agent",
        callType: "subagent",
        name: "Agent",
        status: task.status === "failed" ? "failed" : "completed",
        input: task.input,
        output: { text: summary, ...(usage ? { usage } : {}) },
        content: [{ type: "tool_result", text: summary }],
        metadata
      }
    });
  }

  private emitDelegatedTaskLifecycleEvent(
    type: "task_started" | "task_progress" | "task_completed",
    task: DelegatedTaskState,
    message: Record<string, unknown>
  ): void {
    const turnId = task.turnId || this.activeTurnId();
    if (!turnId) {
      return;
    }
    task.turnId = turnId;
    const taskId = stringValue(message.task_id) || stringValue(message.taskId);
    if (taskId && !task.taskId) {
      task.taskId = taskId;
      this.delegatedParentByTaskID.set(taskId, task.parentToolUseId);
    }
    const description =
      stringValue(message.description) ||
      stringValue(message.summary) ||
      task.description ||
      task.subject;
    const summary = delegatedTaskSummaryFromMessage(message);
    const lastToolName =
      stringValue(message.last_tool_name) || stringValue(message.lastToolName);
    const usage = recordValue(message.usage);
    this.emit({
      type,
      payload: {
        turnId,
        parentToolUseId: task.parentToolUseId,
        toolCallId: task.parentToolUseId,
        callId: task.parentToolUseId,
        ...(task.taskId ? { taskId: task.taskId } : {}),
        ...(task.agentId ? { agentId: task.agentId } : {}),
        ...(task.outputFile ? { outputFile: task.outputFile } : {}),
        status: task.status,
        ...(description ? { description } : {}),
        ...(summary ? { summary } : {}),
        ...(lastToolName ? { lastToolName } : {}),
        ...(usage ? { usage } : {}),
        input: task.input,
        metadata: {
          adapter: "claude-agent-sdk",
          parentToolUseId: task.parentToolUseId,
          async: true,
          subagentAsync: true,
          taskStatus: task.status,
          subagentStatus: task.status,
          ...(task.taskId ? { taskId: task.taskId } : {}),
          ...(task.agentId
            ? { agentId: task.agentId, subagentAgentId: task.agentId }
            : {}),
          ...(task.outputFile
            ? {
                outputFile: task.outputFile,
                subagentOutputFile: task.outputFile
              }
            : {})
        }
      }
    });
  }
}

function delegatedTaskSummaryFromMessage(
  message: Record<string, unknown>
): string {
  return (
    stringValue(message.result) ||
    stringValue(message.summary) ||
    stringValue(message.description)
  );
}

function delegatedTaskStatus(value: unknown): DelegatedTaskStatus {
  switch (stringValue(value)) {
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "canceled":
    case "cancelled":
      return "stopped";
    default:
      return "completed";
  }
}
