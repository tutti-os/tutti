import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import * as readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Settings,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  answersFromInteractivePayload,
  commandEntries,
  contentBlocksFromMessage,
  goalStateFromContentBlocks,
  isThinkingBlock,
  isToolUseBlock,
  numberValue,
  parseJSONObject,
  recordValue,
  sdkContentFromPromptBlocks,
  speedFromFastModeState,
  toolPayload,
  type ToolState
} from "./normalizer.ts";
import {
  claudeQueryOptionOverrides,
  sidecarClaudeOptionsFromPayload,
  type SidecarClaudeOptions
} from "./options.ts";
import {
  parseTaskNotification,
  readQueuedTaskNotificationPrompt,
  readUserMessageNotificationText,
  taskNotificationToSystemMessage
} from "./taskNotification.ts";

type RequestEnvelope = {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type SidecarEvent = {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
};

type PromptQueueItem =
  | {
      type: "message";
      message: SDKUserMessage;
    }
  | {
      type: "close";
    };

type ClaudeQueryRuntime = AsyncIterable<SDKMessage> & {
  initializationResult?: () => Promise<unknown>;
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: PendingFlagSettings) => Promise<void>;
  getContextUsage?: () => Promise<unknown>;
  close?: () => void;
};

type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}) => ClaudeQueryRuntime;

type PendingFlagSettings = {
  [K in keyof Settings]?: Settings[K] | null;
};

type ToolPermissionOptions = {
  readonly signal: AbortSignal;
  readonly suggestions?: PermissionUpdate[];
  readonly toolUseID?: string;
};

type InteractiveSubmission = {
  readonly requestId: string;
  readonly action: string;
  readonly optionId: string;
  readonly payload: Record<string, unknown>;
  readonly turnId: string;
};

type PendingInteraction = {
  readonly requestId: string;
  readonly turnId: string;
  readonly resolve: (value: InteractiveSubmission) => void;
  readonly reject: (error: Error) => void;
};

type SidecarSessionSettings = {
  model: string;
  permissionModeId: string;
  planMode: boolean;
  effort: string;
  speed: string;
};

type SidecarConfigOption = {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: Array<{
    value: string;
    name: string;
    description?: string;
  }>;
};

type RuntimeTurn = {
  readonly turnId: string;
  readonly promptUuid: string;
  readonly synthetic?: boolean;
  settled: boolean;
};

type ClaudeHookCallback = (
  input: unknown,
  toolUseID?: string
) => Promise<{ continue: boolean }>;

type ClaudeTaskState = {
  id: string;
  subject: string;
  description?: string;
  status: string;
};

type DelegatedTaskStatus = "running" | "completed" | "failed" | "stopped";

type DelegatedTaskState = {
  parentToolUseId: string;
  turnId: string;
  input: Record<string, unknown>;
  agentId?: string;
  outputFile?: string;
  taskId?: string;
  subject?: string;
  description?: string;
  status: DelegatedTaskStatus;
  // Tool use id of the delegated task that launched this one, set when a
  // nested agent launch is observed inside a child stream.
  parentTaskToolUseId?: string;
};

type AssistantSegmentKind = "assistant" | "thinking";

type AssistantSegmentState = {
  readonly messageId: string;
  readonly messageBase: string;
  readonly kind: AssistantSegmentKind;
  readonly source: "live" | "fallback";
  readonly liveIndex?: number;
  snapshot: string;
  completed: boolean;
};

const DEFAULT_FORCE_CANCEL_GRACE_MS = 30_000;
const CLAUDE_AUTH_REFRESH_LOG_PREFIX = "CLAUDE_CODE_AUTH_REFRESH_DEBUG";
const CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS = 300;

let cachedClaudeCredentialSnapshot:
  | {
      readonly capturedAtMs: number;
      readonly snapshot: Record<string, unknown>;
    }
  | undefined;

class AsyncPromptQueue {
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
      if (item.type === "close") {
        waiter({ done: true, value: undefined });
      } else {
        waiter({ done: false, value: item.message });
      }
      return;
    }
    this.values.push(item);
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const item = this.values.shift();
    if (item) {
      if (item.type === "close") {
        return Promise.resolve({ done: true, value: undefined });
      }
      return Promise.resolve({ done: false, value: item.message });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class SessionRuntime {
  readonly promptQueue = new AsyncPromptQueue();
  query: ClaudeQueryRuntime | undefined;
  providerSessionId: string;
  activeTurnId = "";
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly restore: boolean;
  private readonly testDriver: boolean;
  private currentAssistantAPIMessageId = "";
  private assistantSegmentSequence = 0;
  private readonly assistantSegmentsByKey = new Map<
    string,
    AssistantSegmentState
  >();
  private readonly assistantSegmentKeyByIndex = new Map<string, string>();
  private readonly toolByIndex = new Map<number, ToolState>();
  private readonly toolByID = new Map<string, ToolState>();
  private compactionInProgress = false;
  private compactCommandTurnId = "";
  private readonly completedCompactTurnIds = new Set<string>();
  private readonly contextUsageSnapshotTurnIds = new Set<string>();
  private pendingOrphanResults = 0;
  private consuming = false;
  private initialized = false;
  private queryClosed = false;
  private cancelled = false;
  private readonly turnQueue: RuntimeTurn[] = [];
  private activeTurn: RuntimeTurn | undefined;
  private cancelController = new AbortController();
  private forceCancelTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTitle = "";
  private lastAssistantUuid = "";
  private turnCount = 0;
  private resumeCursor: Record<string, unknown> | undefined;
  private configOptions: SidecarConfigOption[] = [];
  private readonly settings: SidecarSessionSettings;
  private readonly claudeOptions: SidecarClaudeOptions;
  private readonly queryFactory?: ClaudeQueryFactory;
  private pendingFlagSettings: PendingFlagSettings = {};
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly toolHookResultByID = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly claudeTasks = new Map<string, ClaudeTaskState>();
  private readonly delegatedTasksByParentToolUseID = new Map<
    string,
    DelegatedTaskState
  >();
  private readonly delegatedParentByAgentID = new Map<string, string>();
  private readonly delegatedParentByTaskID = new Map<string, string>();

  constructor(
    providerSessionId: string,
    cwd: string,
    env: Record<string, string | undefined>,
    restore: boolean,
    testDriver: boolean,
    settings: SidecarSessionSettings,
    claudeOptions: SidecarClaudeOptions,
    resumeCursor?: Record<string, unknown>,
    queryFactory?: ClaudeQueryFactory
  ) {
    const resumeSessionId = stringValue(resumeCursor?.resume);
    this.providerSessionId = resumeSessionId || providerSessionId;
    this.cwd = cwd;
    this.env = env;
    this.restore = restore || resumeSessionId !== "";
    this.testDriver = testDriver;
    this.settings = settings;
    this.claudeOptions = claudeOptions;
    this.queryFactory = queryFactory;
    this.resumeCursor = normalizeResumeCursor(
      resumeCursor,
      this.providerSessionId
    );
    this.lastAssistantUuid = stringValue(this.resumeCursor?.resumeSessionAt);
    this.turnCount = numberValue(this.resumeCursor?.turnCount);
    this.mergePendingFlagSettings(flagSettingsFromSessionSettings(settings));
  }

  async start(): Promise<void> {
    this.logAuthRefresh("session_start.begin", {
      restore: this.restore,
      initialized: this.initialized,
      queryClosed: this.queryClosed
    });
    await this.ensureQuery({ initialize: true });
    await this.applyPendingFlagSettings();
    if (this.restore) {
      await this.emitContextUsageSnapshot("");
    }
    emit({
      type: "session_started",
      payload: {
        providerSessionId: this.providerSessionId,
        ...this.sessionStatePayload(),
        resumeCursor: this.currentResumeCursor()
      }
    });
    this.logAuthRefresh("session_start.succeeded", {
      restore: this.restore,
      initialized: this.initialized,
      queryClosed: this.queryClosed
    });
  }

  exec(turnId: string, prompt: string, content?: unknown): void {
    if (this.testDriver) {
      this.activeTurnId = turnId;
      this.resetTurnScratch();
      if (prompt.includes("approval")) {
        void this.handleToolPermission(
          "Bash",
          { command: "touch approval.txt" },
          {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: "test-approval-tool"
          }
        )
          .then(() => this.completeTestDriverTurn(turnId, "Approval accepted."))
          .catch((error) => this.failTestDriverTurn(turnId, error));
        return;
      }
      if (prompt.includes("ask-user")) {
        void this.handleToolPermission(
          "AskUserQuestion",
          {
            questions: [
              {
                header: "Choice",
                question: "Pick one",
                options: [{ label: "A", description: "Alpha" }]
              }
            ]
          },
          {
            signal: new AbortController().signal,
            toolUseID: "test-ask-user-tool"
          }
        )
          .then(() => this.completeTestDriverTurn(turnId, "Question answered."))
          .catch((error) => this.failTestDriverTurn(turnId, error));
        return;
      }
      if (prompt.includes("exit-plan")) {
        void this.handleToolPermission(
          "ExitPlanMode",
          { plan: "1. Inspect\n2. Implement\n3. Verify" },
          {
            signal: new AbortController().signal,
            toolUseID: "test-exit-plan-tool"
          }
        )
          .then(() => this.completeTestDriverTurn(turnId, "Plan captured."))
          .catch((error) => this.failTestDriverTurn(turnId, error));
        return;
      }
      emit({
        type: "assistant_delta",
        payload: {
          turnId,
          content: `Echo: ${prompt}`,
          snapshot: `Echo: ${prompt}`
        }
      });
      emit({
        type: "assistant_completed",
        payload: {
          turnId,
          content: `Echo: ${prompt}`
        }
      });
      emit({
        type: "turn_completed",
        payload: {
          turnId,
          stopReason: "end_turn"
        }
      });
      return;
    }
    if (this.queryClosed) {
      emit({
        type: "turn_failed",
        payload: {
          turnId,
          error: "Claude SDK query is closed"
        }
      });
      return;
    }
    this.closeSyntheticTurnBeforeUserTurn();
    const turn: RuntimeTurn = {
      turnId,
      promptUuid: crypto.randomUUID(),
      settled: false
    };
    if (isCompactCommandPrompt(prompt)) {
      this.compactCommandTurnId = turnId;
    } else {
      this.compactCommandTurnId = "";
    }
    void this.ensureQuery()
      .then(() => this.applyPendingFlagSettings())
      .then(() => {
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
        this.turnQueue.push(turn);
        this.promptQueue.push({
          uuid: turn.promptUuid,
          type: "user",
          session_id: this.providerSessionId,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: sdkContent
          }
        } as SDKUserMessage);
      })
      .then(() => this.consume())
      .catch((error) => {
        this.logAuthRefresh("exec.ensure_query_failed", {
          turnId,
          error: errorPayload(error)
        });
        emit({
          type: "turn_failed",
          payload: {
            turnId,
            error: errorMessage(error)
          }
        });
      });
  }

  async cancel(): Promise<void> {
    if (this.queryClosed) {
      return;
    }
    this.cancelled = true;
    let orphaned = 0;
    const activeTurn = this.activeTurn;
    for (const turn of this.turnQueue) {
      if (turn.settled || turn === activeTurn) {
        continue;
      }
      this.settleQueuedTurn(turn, "turn_canceled");
      orphaned += 1;
    }
    if (orphaned > 0) {
      this.pendingOrphanResults += orphaned;
    }
    this.compactTurnQueue();
    this.rejectPendingInteractions(new Error("Tool use aborted"));
    if (activeTurn && !this.forceCancelTimer) {
      this.forceCancelTimer = setTimeout(() => {
        this.cancelController.abort();
      }, DEFAULT_FORCE_CANCEL_GRACE_MS);
    }
    await this.query?.interrupt?.();
  }

  close(): void {
    this.rejectPendingInteractions(new Error("Tool use aborted"));
    this.clearForceCancelTimer();
    this.cancelController.abort();
    this.queryClosed = true;
    this.promptQueue.close();
    this.query?.close?.();
  }

  submitInteractive(
    requestId: string,
    action: string,
    optionId: string,
    payload: Record<string, unknown>
  ): void {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) {
      throw new Error(`interactive request ${requestId} is no longer live`);
    }
    this.pendingInteractions.delete(requestId);
    pending.resolve({
      requestId,
      action,
      optionId,
      payload,
      turnId: pending.turnId
    });
  }

  async applySettings(payload: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(payload, "planMode")) {
      this.settings.planMode = booleanValue(payload.planMode);
    }
    if (Object.hasOwn(payload, "permissionMode")) {
      await this.applyPermissionMode(stringValue(payload.permissionMode));
    }
    if (Object.hasOwn(payload, "model")) {
      await this.applyModel(stringValue(payload.model));
    }
    if (Object.hasOwn(payload, "effort")) {
      await this.applyEffort(stringValue(payload.effort));
    }
    if (Object.hasOwn(payload, "speed")) {
      const speed = stringValue(payload.speed);
      if (speed === "fast" || speed === "standard") {
        await this.applyFastMode(speed === "fast");
      }
    }
    this.emitSessionState();
  }

  private async applyPermissionMode(mode: string): Promise<void> {
    let permissionMode = permissionModeValue(mode);
    if (!permissionMode) {
      return;
    }
    if (permissionMode === "bypassPermissions" && !canBypassPermissions()) {
      permissionMode = "default";
    }
    if (permissionMode === "plan") {
      this.settings.planMode = true;
    } else {
      this.settings.planMode = false;
      this.settings.permissionModeId = permissionMode;
    }
    if (this.testDriver) {
      return;
    }
    if (!this.query) {
      return;
    }
    if (typeof this.query.setPermissionMode !== "function") {
      throw new Error(
        "Claude SDK runtime does not support live permission mode settings"
      );
    }
    await this.query.setPermissionMode(permissionMode);
  }

  private async applyModel(model: string): Promise<void> {
    const resolvedModel = this.resolveModelOptionValue(model);
    this.settings.model = resolvedModel;
    if (this.testDriver || !this.query) {
      return;
    }
    if (typeof this.query.setModel !== "function") {
      throw new Error(
        "Claude SDK runtime does not support live model settings"
      );
    }
    await this.query.setModel(
      resolvedModel === "" || resolvedModel === "default"
        ? undefined
        : resolvedModel
    );
    this.updateConfigOptionCurrentValue("model", resolvedModel || "default");
  }

  private async applyEffort(effort: string): Promise<void> {
    this.settings.effort = effort;
    this.mergePendingFlagSettings({ effortLevel: effortLevelValue(effort) });
    await this.applyPendingFlagSettings();
  }

  private async applyFastMode(enabled: boolean): Promise<void> {
    this.settings.speed = enabled ? "fast" : "standard";
    this.mergePendingFlagSettings({ fastMode: enabled });
    await this.applyPendingFlagSettings();
  }

  private async applyPendingFlagSettings(): Promise<void> {
    if (Object.keys(this.pendingFlagSettings).length === 0) {
      return;
    }
    if (this.testDriver) {
      const enabled = this.pendingFlagSettings.fastMode;
      this.pendingFlagSettings = {};
      if (typeof enabled === "boolean") {
        this.emitFastModeState(enabled ? "on" : "off");
      }
      return;
    }
    if (!this.query) {
      return;
    }
    if (typeof this.query.applyFlagSettings !== "function") {
      throw new Error("Claude SDK runtime does not support live flag settings");
    }
    if (!this.initialized && this.query.initializationResult) {
      await this.query.initializationResult();
      this.initialized = true;
    }
    const settings = this.pendingFlagSettings;
    this.pendingFlagSettings = {};
    await this.query.applyFlagSettings(settings);
    if (typeof settings.fastMode === "boolean") {
      this.emitFastModeState(settings.fastMode ? "on" : "off");
    }
  }

  private mergePendingFlagSettings(settings: PendingFlagSettings): void {
    for (const [key, value] of Object.entries(settings) as Array<
      [keyof Settings, Settings[keyof Settings] | null | undefined]
    >) {
      if (value !== undefined) {
        this.pendingFlagSettings[key] = value;
      }
    }
  }

  private consume(): void {
    if (!this.query || this.consuming) {
      return;
    }
    this.consuming = true;
    void (async () => {
      const iterator = this.query?.[Symbol.asyncIterator]();
      try {
        if (!iterator) {
          return;
        }
        for (;;) {
          let next: IteratorResult<SDKMessage>;
          try {
            next = await this.nextQueryMessage(iterator);
          } catch (error) {
            if (isAbortError(error)) {
              this.settleActive("turn_canceled");
              this.cancelled = false;
              this.cancelController = new AbortController();
              continue;
            }
            throw error;
          }
          if (next.done) {
            break;
          }
          const message = next.value;
          await this.handleMessage(message);
        }
      } catch (error) {
        this.logAuthRefresh("query_consume.failed", {
          activeTurnId: this.activeTurnId,
          queuedTurnIds: this.turnQueue
            .filter((turn) => !turn.settled)
            .map((turn) => turn.turnId),
          error: errorPayload(error)
        });
        this.failLiveTurns(errorMessage(error));
      } finally {
        this.queryClosed = true;
        this.query = undefined;
        this.consuming = false;
        if (this.activeTurn) {
          this.settleActive(this.cancelled ? "turn_canceled" : "turn_failed");
        }
        this.failQueuedTurns("Claude SDK session ended");
        this.cancelled = false;
      }
    })();
  }

  private nextQueryMessage(
    iterator: AsyncIterator<SDKMessage>
  ): Promise<IteratorResult<SDKMessage>> {
    const signal = this.cancelController.signal;
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return Promise.race([
      iterator.next(),
      new Promise<IteratorResult<SDKMessage>>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), {
          once: true
        });
      })
    ]);
  }

  private completeTestDriverTurn(turnId: string, content: string): void {
    emit({
      type: "assistant_completed",
      payload: { turnId, content }
    });
    emit({
      type: "turn_completed",
      payload: {
        turnId,
        stopReason: "end_turn"
      }
    });
  }

  private failTestDriverTurn(turnId: string, error: unknown): void {
    emit({
      type: "turn_failed",
      payload: {
        turnId,
        error: errorMessage(error)
      }
    });
  }

  private async handleToolPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(toolInput, callbackOptions);
    }
    if (toolName === "ExitPlanMode") {
      const submission = await this.requestInteractive(
        "user_input_requested",
        toolName,
        toolInput,
        exitPlanOptions(),
        callbackOptions
      );
      this.emitInteractiveResolved("user_input_resolved", submission);
      if (isExitPlanAllowOption(submission.optionId)) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: callbackOptions.suggestions ?? [
            {
              type: "setMode",
              mode: submission.optionId as PermissionMode,
              destination: "session"
            } as PermissionUpdate
          ]
        };
      }
      return {
        behavior: "deny",
        message: "User rejected request to exit plan mode."
      };
    }
    if (effectivePermissionMode(this.settings) === "bypassPermissions") {
      return {
        behavior: "allow",
        updatedInput: toolInput
      };
    }

    const submission = await this.requestInteractive(
      "approval_requested",
      toolName,
      toolInput,
      approvalOptions(),
      callbackOptions
    );
    this.emitInteractiveResolved("approval_resolved", submission);
    if (isAllowOption(submission.optionId)) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(submission.optionId === "allow_always" &&
        callbackOptions.suggestions
          ? { updatedPermissions: [...callbackOptions.suggestions] }
          : {})
      };
    }
    return {
      behavior: "deny",
      message:
        stringValue(submission.payload.denyMessage) ||
        "User refused permission to run tool"
    };
  }

  private async handleAskUserQuestion(
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    const submission = await this.requestInteractive(
      "user_input_requested",
      "AskUserQuestion",
      toolInput,
      [],
      callbackOptions
    );
    this.emitInteractiveResolved("user_input_resolved", submission);
    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers: answersFromInteractivePayload(submission.payload, toolInput)
      }
    };
  }

  private requestInteractive(
    eventType: "approval_requested" | "user_input_requested",
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Array<Record<string, unknown>>,
    callbackOptions: ToolPermissionOptions
  ): Promise<InteractiveSubmission> {
    const requestId = crypto.randomUUID();
    const toolUseID = callbackOptions.toolUseID || requestId;
    // Never emit a turnless interactive request: the daemon rejects it and
    // the requesting agent would wait forever on an invisible approval.
    const turnId =
      this.resolveInteractiveTurnId(callbackOptions) ||
      this.activateSyntheticTurn().turnId;
    const request = new Promise<InteractiveSubmission>((resolve, reject) => {
      this.pendingInteractions.set(requestId, {
        requestId,
        turnId,
        resolve,
        reject
      });
      callbackOptions.signal.addEventListener(
        "abort",
        () => {
          if (!this.pendingInteractions.has(requestId)) {
            return;
          }
          this.pendingInteractions.delete(requestId);
          reject(new Error("Tool use aborted"));
        },
        { once: true }
      );
    });
    emit({
      type: eventType,
      payload: {
        turnId,
        requestId,
        toolCallId: toolUseID,
        toolName,
        input: toolInput,
        options,
        toolCall: {
          toolCallId: toolUseID,
          name: toolName,
          title: toolName,
          toolName,
          input: toolInput
        }
      }
    });
    return request;
  }

  private resolveInteractiveTurnId(
    callbackOptions: ToolPermissionOptions
  ): string {
    if (this.activeTurnId) {
      return this.activeTurnId;
    }
    const toolUseID = stringValue(callbackOptions.toolUseID);
    if (toolUseID) {
      const tool = this.toolByID.get(toolUseID);
      const parentToolUseID = stringValue(tool?.parentToolUseId);
      if (parentToolUseID) {
        const task = this.delegatedTasksByParentToolUseID.get(parentToolUseID);
        if (task?.turnId) {
          return task.turnId;
        }
      }
    }
    for (let index = this.turnQueue.length - 1; index >= 0; index -= 1) {
      const turn = this.turnQueue[index];
      if (turn && !turn.settled && !turn.synthetic) {
        return turn.turnId;
      }
    }
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (task.status === "running" && task.turnId) {
        return task.turnId;
      }
    }
    for (let index = this.turnQueue.length - 1; index >= 0; index -= 1) {
      const turn = this.turnQueue[index];
      if (turn && !turn.settled) {
        return turn.turnId;
      }
    }
    // A settled delegated task is still a better anchor than an empty turn
    // id: turnless interactive events are rejected by the daemon activity
    // store, which silently drops the approval card and deadlocks the
    // requesting nested agent.
    let latestTaskTurnId = "";
    for (const task of this.delegatedTasksByParentToolUseID.values()) {
      if (task.turnId) {
        latestTaskTurnId = task.turnId;
      }
    }
    return latestTaskTurnId;
  }

  private emitInteractiveResolved(
    eventType: "approval_resolved" | "user_input_resolved",
    submission: InteractiveSubmission
  ): void {
    emit({
      type: eventType,
      payload: {
        turnId:
          submission.turnId ||
          this.resolveInteractiveTurnId({} as ToolPermissionOptions),
        requestId: submission.requestId,
        action: submission.action,
        optionId: submission.optionId,
        payload: submission.payload
      }
    });
  }

  private async ensureQuery(
    startOptions: { initialize?: boolean } = {}
  ): Promise<void> {
    if (this.query || this.testDriver) {
      return;
    }
    const queryFactory =
      this.queryFactory ??
      (await import("@anthropic-ai/claude-agent-sdk")).query;
    const permissionMode = effectivePermissionMode(this.settings);
    const allowBypassPermissions = canBypassPermissions();
    const querySettings = querySettingsFromSessionSettings(this.settings);
    const queryOptions: ClaudeQueryOptions = {
      cwd: this.cwd || process.cwd(),
      env: {
        ...process.env,
        ...this.env,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1"
      },
      includePartialMessages: true,
      canUseTool: (toolName, toolInput, callbackOptions) =>
        this.handleToolPermission(
          String(toolName),
          recordValue(toolInput) ?? {},
          callbackOptions as ToolPermissionOptions
        ),
      ...(this.restore
        ? { resume: this.providerSessionId }
        : { sessionId: this.providerSessionId }),
      ...(modelOptionValue(this.settings.model)
        ? { model: modelOptionValue(this.settings.model) }
        : {}),
      ...(permissionMode ? { permissionMode } : {}),
      allowDangerouslySkipPermissions: allowBypassPermissions,
      ...(Object.keys(querySettings).length > 0
        ? { settings: querySettings }
        : {}),
      ...claudeQueryOptionOverrides(this.claudeOptions),
      hooks: {
        PostToolUse: [
          {
            hooks: [
              ((input, toolUseID) =>
                this.handlePostToolUseHook(
                  input,
                  toolUseID
                )) satisfies ClaudeHookCallback
            ]
          }
        ],
        TaskCreated: [
          {
            hooks: [
              ((input) =>
                this.handleTaskLifecycleHook(
                  input
                )) satisfies ClaudeHookCallback
            ]
          }
        ],
        TaskCompleted: [
          {
            hooks: [
              ((input) =>
                this.handleTaskLifecycleHook(
                  input
                )) satisfies ClaudeHookCallback
            ]
          }
        ]
      }
    } as ClaudeQueryOptions & {
      hooks: Record<string, Array<{ hooks: ClaudeHookCallback[] }>>;
    };
    this.logAuthRefresh("query_create.begin", {
      initialize: startOptions.initialize === true,
      restore: this.restore,
      permissionMode,
      hasModel: Boolean(modelOptionValue(this.settings.model)),
      hasResumeCursor: Boolean(this.resumeCursor),
      querySettingsKeys: Object.keys(querySettings),
      claudeOptionKeys: Object.keys(
        claudeQueryOptionOverrides(this.claudeOptions)
      )
    });
    this.query = queryFactory({
      prompt: this.promptQueue.iterate(),
      options: queryOptions
    }) as ClaudeQueryRuntime;
    this.logAuthRefresh("query_create.succeeded", {
      initialize: startOptions.initialize === true,
      restore: this.restore,
      hasInitializationResult:
        typeof this.query.initializationResult === "function"
    });
    if (startOptions.initialize) {
      try {
        this.logAuthRefresh("query_initialization.begin", {
          restore: this.restore
        });
        const initializationResult = await this.query.initializationResult?.();
        this.applyInitializationResult(initializationResult);
        this.initialized = true;
        this.logAuthRefresh("query_initialization.succeeded", {
          restore: this.restore,
          resultKeys: Object.keys(recordValue(initializationResult) ?? {})
        });
      } catch (error) {
        this.logAuthRefresh("query_initialization.failed", {
          restore: this.restore,
          error: errorPayload(error)
        });
        this.query.close?.();
        this.query = undefined;
        this.initialized = false;
        throw error;
      }
    }
  }

  private logAuthRefresh(
    stage: string,
    payload: Record<string, unknown>
  ): void {
    debugClaudeAuthRefreshLog(stage, {
      providerSessionId: this.providerSessionId,
      cwd: this.cwd,
      credentials: claudeCredentialSnapshot(),
      ...payload
    });
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    const parentToolUseID = readSDKParentToolUseID(message);
    const sessionId = readSDKSessionID(message);
    if (sessionId && sessionId !== this.providerSessionId) {
      this.providerSessionId = sessionId;
      this.emitSessionState();
    }
    const assistantUuid = readSDKAssistantUuid(message);
    if (assistantUuid && !parentToolUseID) {
      this.lastAssistantUuid = assistantUuid;
      this.emitSessionState();
    }

    const messageType = (message as { type?: string }).type;
    if (messageType === "attachment") {
      const prompt = readQueuedTaskNotificationPrompt(
        message as unknown as Record<string, unknown>
      );
      if (prompt) {
        this.handleTaskNotificationFromText(prompt);
      }
      return;
    }

    if (message.type === "system") {
      this.handleSystemMessage(message as unknown as Record<string, unknown>);
      return;
    }

    if (message.type === "stream_event") {
      if (!this.ensureActiveTurn("stream_event")) {
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
      };
      if (streamEvent.type === "message_start") {
        if (!parentToolUseID) {
          this.currentAssistantAPIMessageId = stringValue(
            streamEvent.message?.id
          );
          this.assistantSegmentKeyByIndex.clear();
        }
        return;
      }
      if (streamEvent.type === "content_block_start") {
        this.handleContentBlockStart(streamEvent, parentToolUseID);
        return;
      }
      if (streamEvent.type === "content_block_stop") {
        this.handleContentBlockStop(streamEvent);
        return;
      }
      if (streamEvent.type === "message_delta") {
        if (parentToolUseID) {
          return;
        }
        const usage = recordValue((streamEvent as { usage?: unknown }).usage);
        if (usage) {
          emit({
            type: "usage_updated",
            payload: {
              turnId: this.activeTurnId,
              usage
            }
          });
          this.requestContextUsageSnapshot(this.activeTurnId);
        }
        return;
      }
      if (streamEvent.type !== "content_block_delta") {
        return;
      }
      const delta = streamEvent.delta;
      if (!delta) {
        return;
      }
      if (delta.type === "input_json_delta") {
        this.handleToolInputDelta(
          streamEvent.index,
          (delta as { partial_json?: unknown }).partial_json
        );
        return;
      }
      const text =
        delta.type === "text_delta"
          ? delta.text
          : delta.type === "thinking_delta"
            ? delta.thinking
            : "";
      if (!text) {
        return;
      }
      if (parentToolUseID) {
        return;
      }
      if (delta.type === "text_delta") {
        this.appendAssistantSegmentDelta(streamEvent.index, "assistant", text);
      }
      if (delta.type === "thinking_delta") {
        this.appendAssistantSegmentDelta(streamEvent.index, "thinking", text);
      }
      return;
    }

    if (message.type === "assistant") {
      if (parentToolUseID) {
        // Nested agent launches (grandchild Task calls) only surface as
        // tool_use blocks inside child-stream assistant messages. Register
        // them so their launch results can create delegated task state and
        // later events (approvals, notifications) can resolve a turn id.
        for (const block of contentBlocksFromMessage(message)) {
          if (isToolUseBlock(block)) {
            this.upsertToolUse(
              block,
              undefined,
              "tool_updated",
              parentToolUseID
            );
          }
        }
        if (
          this.isNestedDelegatedTaskTerminalAssistant(message) &&
          !this.hasUnsettledChildWork(parentToolUseID)
        ) {
          this.completeDelegatedTaskFromParentMessage(parentToolUseID, {
            status: "completed",
            summary:
              this.extractAssistantTextFromMessage(message) ||
              "Subagent task completed."
          });
        }
        // Child-agent assistant messages stream through the parent query while
        // the child is still running, so they are not a completion signal.
        // Delegated tasks settle through the child result message, the
        // task_notification system message, the TaskCompleted hook, or a
        // terminal assistant message tagged with end_turn once no launched
        // child tasks remain running.
        return;
      }
      if (!this.ensureActiveTurn("assistant")) {
        return;
      }
      const messageId = readSDKAssistantMessageID(message);
      const blocks = contentBlocksFromMessage(message);
      const usedAssistantSegmentIds = new Set<string>();
      for (const block of blocks) {
        this.handleAssistantContentBlock(
          block,
          parentToolUseID,
          messageId,
          usedAssistantSegmentIds
        );
      }
      this.emitGoalStatusFromBlocks(blocks);
      return;
    }

    if (message.type === "user") {
      const notificationText = readUserMessageNotificationText(
        message as { message?: { content?: unknown } }
      );
      if (notificationText.includes("<task-notification>")) {
        this.handleTaskNotificationFromText(notificationText);
      }
      this.activateTurnForUserMessage(message);
      const blocks = contentBlocksFromMessage(message);
      if (
        this.pendingOrphanResults > 0 &&
        blocks.some((block) => block.type === "text")
      ) {
        this.pendingOrphanResults = 0;
      }
      for (const block of blocks) {
        this.handleUserContentBlock(block, parentToolUseID);
      }
      this.emitGoalStatusFromBlocks(blocks);
      return;
    }

    if (message.type === "tool_progress") {
      if (!this.ensureActiveTurn("tool_progress")) {
        return;
      }
      this.handleToolProgress(
        message as Record<string, unknown>,
        parentToolUseID
      );
      return;
    }

    if (message.type === "result") {
      if (parentToolUseID) {
        this.completeDelegatedTaskFromResultMessage(parentToolUseID, message);
        return;
      }
      const result = message as {
        subtype?: string;
        errors?: string[];
        usage?: unknown;
        modelUsage?: unknown;
        total_cost_usd?: unknown;
      };
      this.emitFastModeStateFromMessage(
        message as unknown as Record<string, unknown>
      );
      if (this.pendingOrphanResults > 0) {
        this.pendingOrphanResults -= 1;
        return;
      }
      const active = this.ensureActiveTurn("result");
      if (!active) {
        return;
      }
      emitUsageUpdated(this.activeTurnId, {
        usage: result.usage,
        modelUsage: result.modelUsage,
        totalCostUsd: result.total_cost_usd
      });
      await this.emitContextUsageSnapshot(this.activeTurnId, {
        modelUsage: result.modelUsage
      });
      await this.maybeEmitSessionTitleUpdated();
      if (this.cancelled) {
        this.settleActive("turn_canceled");
        this.cancelled = false;
        return;
      }
      if (result.subtype === "success") {
        this.settleActive("turn_completed", { stopReason: "end_turn" });
      } else {
        this.settleActive("turn_failed", {
          error: result.errors?.[0] ?? "Claude SDK turn failed"
        });
      }
    }
  }

  private activateTurnForUserMessage(message: SDKMessage): void {
    const promptUuid = readSDKMessageUuid(message);
    if (promptUuid) {
      const matched = this.turnQueue.find(
        (turn) => !turn.settled && turn.promptUuid === promptUuid
      );
      if (matched) {
        this.activateTurn(matched);
      }
    }
    if (!this.activeTurn) {
      this.ensureActiveTurn("user");
    }
  }

  private ensureActiveTurn(messageType: string): RuntimeTurn | undefined {
    if (this.activeTurn && !this.activeTurn.settled) {
      return this.activeTurn;
    }
    if (messageType !== "user" && this.pendingOrphanResults > 0) {
      return undefined;
    }
    const turn = this.turnQueue.find((candidate) => !candidate.settled);
    if (!turn) {
      if (messageType === "assistant") {
        return this.activateSyntheticTurn();
      }
      return undefined;
    }
    this.activateTurn(turn);
    return turn;
  }

  private activateSyntheticTurn(): RuntimeTurn {
    const turn: RuntimeTurn = {
      turnId: `synthetic-${crypto.randomUUID()}`,
      promptUuid: "",
      synthetic: true,
      settled: false
    };
    this.turnQueue.push(turn);
    this.activateTurn(turn);
    return turn;
  }

  private closeSyntheticTurnBeforeUserTurn(): void {
    if (!this.activeTurn?.synthetic || this.activeTurn.settled) {
      return;
    }
    this.settleActive("turn_completed", { stopReason: "background_agent" });
  }

  private activateTurn(turn: RuntimeTurn): void {
    if (this.activeTurn === turn) {
      return;
    }
    this.activeTurn = turn;
    this.activeTurnId = turn.turnId;
    this.cancelled = false;
    this.pendingOrphanResults = 0;
    this.resetTurnScratch();
    if (turn.synthetic) {
      emit({
        type: "turn_started",
        payload: {
          turnId: turn.turnId,
          synthetic: true
        }
      });
    }
  }

  private resetTurnScratch(): void {
    this.currentAssistantAPIMessageId = "";
    this.assistantSegmentSequence = 0;
    this.assistantSegmentsByKey.clear();
    this.assistantSegmentKeyByIndex.clear();
    this.toolByIndex.clear();
    this.toolByID.clear();
    this.toolHookResultByID.clear();
    this.claudeTasks.clear();
  }

  private settleActive(
    type: "turn_completed" | "turn_canceled" | "turn_failed",
    payload: Record<string, unknown> = {}
  ): void {
    const turn = this.activeTurn;
    if (!turn || turn.settled) {
      return;
    }
    turn.settled = true;
    this.turnCount += 1;
    emit({
      type,
      payload: {
        ...payload,
        turnId: turn.turnId
      }
    });
    this.clearForceCancelTimer();
    this.activeTurn = undefined;
    this.activeTurnId = "";
    this.compactTurnQueue();
    this.emitSessionState();
  }

  private settleQueuedTurn(
    turn: RuntimeTurn,
    type: "turn_canceled" | "turn_failed",
    payload: Record<string, unknown> = {}
  ): void {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    emit({
      type,
      payload: {
        ...payload,
        turnId: turn.turnId
      }
    });
  }

  private compactTurnQueue(): void {
    for (;;) {
      const turn = this.turnQueue[0];
      if (!turn || !turn.settled) {
        return;
      }
      this.turnQueue.shift();
    }
  }

  private clearForceCancelTimer(): void {
    if (!this.forceCancelTimer) {
      return;
    }
    clearTimeout(this.forceCancelTimer);
    this.forceCancelTimer = undefined;
  }

  private failLiveTurns(error: string): void {
    if (this.activeTurn) {
      this.settleActive(this.cancelled ? "turn_canceled" : "turn_failed", {
        error
      });
    }
    this.failQueuedTurns(error);
  }

  private failQueuedTurns(error: string): void {
    for (const turn of this.turnQueue) {
      if (turn.settled || turn === this.activeTurn) {
        continue;
      }
      this.settleQueuedTurn(
        turn,
        this.cancelled ? "turn_canceled" : "turn_failed",
        {
          error
        }
      );
    }
    this.compactTurnQueue();
  }

  private rejectPendingInteractions(error: Error): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      this.pendingInteractions.delete(requestId);
      pending.reject(error);
    }
  }

  private currentResumeCursor(): Record<string, unknown> {
    this.resumeCursor = {
      kind: "claude-agent-sdk",
      version: 1,
      resume: this.providerSessionId,
      ...(this.lastAssistantUuid
        ? { resumeSessionAt: this.lastAssistantUuid }
        : {}),
      turnCount: this.turnCount
    };
    return this.resumeCursor;
  }

  private emitSessionState(): void {
    emit({
      type: "session_state",
      payload: {
        providerSessionId: this.providerSessionId,
        ...this.sessionStatePayload(),
        resumeCursor: this.currentResumeCursor()
      }
    });
  }

  private sessionStatePayload(): Record<string, unknown> {
    return {
      ...(this.settings.model ? { model: this.settings.model } : {}),
      ...(this.configOptions.length > 0
        ? { configOptions: this.configOptions }
        : {})
    };
  }

  private applyInitializationResult(value: unknown): void {
    const result = recordValue(value);
    if (!result) {
      return;
    }
    const modelOptions = sidecarModelOptionsFromInitializationResult(result);
    if (modelOptions.length === 0) {
      return;
    }
    const currentModel =
      this.resolveModelOptionValue(this.settings.model) ||
      defaultSidecarModelOptionValue(modelOptions);
    this.settings.model = currentModel;
    this.configOptions = [
      {
        id: "model",
        name: "Model",
        description: "AI model to use",
        category: "model",
        type: "select",
        currentValue: currentModel || "default",
        options: modelOptions
      }
    ];
  }

  private resolveModelOptionValue(model: string): string {
    const requested = stringValue(model);
    if (!requested) {
      return "";
    }
    const modelOption = this.configOptions.find(
      (option) => option.id === "model"
    );
    if (!modelOption) {
      return requested;
    }
    const exact = modelOption.options.find(
      (option) => option.value === requested
    );
    if (exact) {
      return exact.value;
    }
    const lower = requested.toLowerCase();
    const matched = modelOption.options.find((option) => {
      const value = option.value.toLowerCase();
      const name = option.name.toLowerCase();
      return value === lower || name === lower;
    });
    return matched?.value ?? requested;
  }

  private updateConfigOptionCurrentValue(id: string, value: string): void {
    this.configOptions = this.configOptions.map((option) =>
      option.id === id ? { ...option, currentValue: value } : option
    );
  }

  private async maybeEmitSessionTitleUpdated(): Promise<void> {
    if (this.testDriver || !this.providerSessionId) {
      return;
    }
    try {
      const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
      const info = recordValue(
        await getSessionInfo(this.providerSessionId, {
          dir: this.cwd || process.cwd()
        })
      );
      const title = normalizeTitle(
        stringValue(info?.customTitle) || stringValue(info?.summary)
      );
      if (!title || title === this.lastTitle) {
        return;
      }
      this.lastTitle = title;
      emit({
        type: "session_title_updated",
        payload: {
          providerSessionId: this.providerSessionId,
          title
        }
      });
    } catch {
      // Title updates are best-effort; the turn result should not fail because
      // Claude Code has not written session metadata yet.
    }
  }

  private handleSystemMessage(message: Record<string, unknown>): void {
    this.emitFastModeStateFromMessage(message);
    const subtype = stringValue(message.subtype);
    if (
      subtype === "task_started" ||
      subtype === "task_progress" ||
      subtype === "task_notification"
    ) {
      this.handleTaskSystemMessage(subtype, message);
      return;
    }
    if (subtype === "task_updated") {
      const patch = recordValue(message.patch);
      const status = stringValue(patch?.status);
      if (
        status === "completed" ||
        status === "failed" ||
        status === "killed"
      ) {
        this.handleTaskSystemMessage("task_notification", {
          task_id: stringValue(message.task_id),
          tool_use_id: stringValue(message.tool_use_id),
          status: status === "killed" ? "stopped" : status,
          summary:
            stringValue(patch?.description) ||
            stringValue(message.summary) ||
            stringValue(message.description)
        });
      }
      return;
    }
    if (subtype === "init" || subtype === "commands_changed") {
      const commands = commandEntries(message.commands);
      if (commands.length > 0 || Array.isArray(message.commands)) {
        emit({
          type: "commands_updated",
          payload: {
            providerSessionId: this.providerSessionId,
            commands
          }
        });
      }
      return;
    }
    if (subtype === "status") {
      if (message.status === "compacting") {
        this.ensureActiveTurn("compact_status");
        this.pendingOrphanResults = 0;
        this.compactionInProgress = true;
        emit({
          type: "compact_started",
          payload: {
            turnId: this.activeTurnId,
            content: "Compacting..."
          }
        });
        return;
      }
      const compactResult = stringValue(message.compact_result);
      if (compactResult === "success" && this.compactionInProgress) {
        this.compactionInProgress = false;
        this.emitCompactCompleted(
          this.compactEventTurnId(),
          "Compacting completed."
        );
        return;
      }
      if (compactResult === "failed" && this.compactionInProgress) {
        this.compactionInProgress = false;
        const reason = stringValue(message.compact_error);
        emit({
          type: "compact_failed",
          payload: {
            turnId: this.activeTurnId,
            content: reason
              ? `Compacting failed: ${reason}`
              : "Compacting failed."
          }
        });
        return;
      }
    }
    if (subtype === "compact_boundary") {
      this.ensureActiveTurn("compact_boundary");
      const turnId = this.compactEventTurnId();
      this.emitCompactBoundaryUsage(message, turnId);
      this.emitCompactBoundaryCompletion();
    }
  }

  private handleTaskNotificationFromText(text: string): void {
    const parsed = parseTaskNotification(text);
    if (!parsed) {
      return;
    }
    this.handleTaskSystemMessage(
      "task_notification",
      taskNotificationToSystemMessage(parsed)
    );
  }

  private handleTaskSystemMessage(
    subtype: "task_started" | "task_progress" | "task_notification",
    message: Record<string, unknown>
  ): void {
    const task = this.resolveDelegatedTaskFromMessage(message);
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
      task.status = delegatedTaskStatus(message.status);
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

  private emitFastModeStateFromMessage(message: Record<string, unknown>): void {
    if (!Object.hasOwn(message, "fast_mode_state")) {
      return;
    }
    this.emitFastModeState(message.fast_mode_state);
  }

  private emitFastModeState(state: unknown): void {
    const rawState = stringValue(state);
    if (!rawState) {
      return;
    }
    const payload: Record<string, unknown> = { state: rawState };
    const speed = speedFromFastModeState(rawState);
    if (speed) {
      payload.speed = speed;
    }
    emit({
      type: "speed_updated",
      payload
    });
  }

  private emitCompactBoundaryUsage(
    message: Record<string, unknown>,
    turnId: string
  ): void {
    const metadata = recordValue(message.compact_metadata);
    const postTokens = numberValue(metadata?.post_tokens);
    const preTokens = numberValue(metadata?.pre_tokens);
    if (postTokens > 0 && turnId) {
      emitUsageUpdated(turnId, {
        contextWindow: {
          usedTokens: postTokens,
          ...(preTokens > 0 ? { lastUsedTokens: preTokens } : {})
        }
      });
    }
    void this.emitContextUsageSnapshot(turnId);
  }

  private emitCompactBoundaryCompletion(): void {
    const turnId = this.compactEventTurnId();
    if (!turnId) {
      return;
    }
    if (!this.compactionInProgress && turnId !== this.compactCommandTurnId) {
      return;
    }
    this.compactionInProgress = false;
    this.emitCompactCompleted(turnId, "Compacting completed.");
  }

  private emitCompactCompleted(turnId: string, content: string): void {
    if (!turnId || this.completedCompactTurnIds.has(turnId)) {
      return;
    }
    this.completedCompactTurnIds.add(turnId);
    emit({
      type: "compact_completed",
      payload: {
        turnId,
        content
      }
    });
  }

  private compactEventTurnId(): string {
    if (this.activeTurnId) {
      return this.activeTurnId;
    }
    return this.compactCommandTurnId;
  }

  private async emitContextUsageSnapshot(
    turnId: string,
    options: { modelUsage?: unknown } = {}
  ): Promise<void> {
    const getContextUsage = this.query?.getContextUsage;
    if (!getContextUsage) {
      return;
    }
    try {
      const contextUsage = recordValue(await getContextUsage());
      if (!contextUsage) {
        return;
      }
      const usedTokens = numberValue(contextUsage.totalTokens);
      const contextWindowTokens =
        contextWindowTokensFromModelUsage(options.modelUsage) ||
        numberValue(contextUsage.rawMaxTokens) ||
        numberValue(contextUsage.maxTokens);
      if (usedTokens <= 0 && contextWindowTokens <= 0) {
        return;
      }
      emitUsageUpdated(turnId, {
        contextWindow: {
          usedTokens,
          ...(contextWindowTokens > 0
            ? { totalTokens: contextWindowTokens }
            : {}),
          compactsAutomatically: contextUsage.isAutoCompactEnabled === true
        }
      });
    } catch {
      // Context usage is best-effort; result usage remains available.
    }
  }

  private requestContextUsageSnapshot(turnId: string): void {
    if (!turnId || this.contextUsageSnapshotTurnIds.has(turnId)) {
      return;
    }
    this.contextUsageSnapshotTurnIds.add(turnId);
    void this.emitContextUsageSnapshot(turnId);
  }

  private appendAssistantSegmentDelta(
    index: number | undefined,
    kind: AssistantSegmentKind,
    delta: string
  ): void {
    const segment = this.ensureLiveAssistantSegment(index, kind);
    this.emitAssistantSegmentDelta(segment, delta);
  }

  private emitAssistantSegmentDelta(
    segment: AssistantSegmentState,
    delta: string
  ): void {
    if (!delta) {
      return;
    }
    segment.snapshot += delta;
    emit({
      type: segment.kind === "assistant" ? "assistant_delta" : "thinking_delta",
      payload: {
        turnId: this.activeTurnId,
        messageId: segment.messageId,
        content: delta,
        snapshot: segment.snapshot
      }
    });
  }

  private ensureLiveAssistantSegment(
    index: number | undefined,
    kind: AssistantSegmentKind,
    messageBase = ""
  ): AssistantSegmentState {
    const existing = this.assistantSegmentForIndex(index, kind);
    if (existing && !existing.completed && existing.kind === kind) {
      return existing;
    }
    return this.createAssistantSegment(kind, "live", messageBase, index);
  }

  private ensureFallbackAssistantSegment(
    kind: AssistantSegmentKind,
    messageBase = ""
  ): AssistantSegmentState {
    return this.createAssistantSegment(
      kind,
      "fallback",
      messageBase || this.activeTurnId
    );
  }

  private createAssistantSegment(
    kind: AssistantSegmentKind,
    source: "live" | "fallback",
    messageBase = "",
    liveIndex?: number
  ): AssistantSegmentState {
    const base =
      messageBase || this.currentAssistantAPIMessageId || this.activeTurnId;
    const sequence = this.assistantSegmentSequence++;
    const messageId = `claude-sdk:${kind}:${base}:${source}:${sequence}`;
    const key = `${kind}:${messageId}`;
    const segment: AssistantSegmentState = {
      messageId,
      messageBase: base,
      kind,
      source,
      ...(typeof liveIndex === "number" ? { liveIndex } : {}),
      snapshot: "",
      completed: false
    };
    this.assistantSegmentsByKey.set(key, segment);
    if (typeof liveIndex === "number") {
      this.assistantSegmentKeyByIndex.set(
        assistantSegmentIndexKey(kind, liveIndex),
        key
      );
    }
    return segment;
  }

  private assistantSegmentForIndex(
    index: number | undefined,
    kind?: AssistantSegmentKind
  ): AssistantSegmentState | undefined {
    if (typeof index !== "number") {
      return undefined;
    }
    if (kind) {
      const key = this.assistantSegmentKeyByIndex.get(
        assistantSegmentIndexKey(kind, index)
      );
      return key ? this.assistantSegmentsByKey.get(key) : undefined;
    }
    const key =
      this.assistantSegmentKeyByIndex.get(
        assistantSegmentIndexKey("assistant", index)
      ) ??
      this.assistantSegmentKeyByIndex.get(
        assistantSegmentIndexKey("thinking", index)
      );
    return key ? this.assistantSegmentsByKey.get(key) : undefined;
  }

  private completeAssistantSegment(
    index: number | undefined,
    segment: AssistantSegmentState,
    fallbackText = ""
  ): void {
    if (typeof index === "number") {
      this.assistantSegmentKeyByIndex.delete(
        assistantSegmentIndexKey(segment.kind, index)
      );
    }
    if (segment.completed) {
      return;
    }
    const tail =
      fallbackText && fallbackText.startsWith(segment.snapshot)
        ? fallbackText.slice(segment.snapshot.length)
        : "";
    if (tail && (segment.source !== "fallback" || segment.snapshot)) {
      this.emitAssistantSegmentDelta(segment, tail);
    } else if (!segment.snapshot && fallbackText) {
      segment.snapshot = fallbackText;
    }
    segment.completed = true;
    if (!segment.snapshot) {
      return;
    }
    emit({
      type:
        segment.kind === "assistant"
          ? "assistant_completed"
          : "thinking_completed",
      payload: {
        turnId: this.activeTurnId,
        messageId: segment.messageId,
        content: segment.snapshot
      }
    });
  }

  private assistantSegmentWithContent(
    kind: AssistantSegmentKind,
    messageBase: string,
    content: string,
    usedSegmentIds: Set<string>
  ): AssistantSegmentState | undefined {
    if (!content) {
      return undefined;
    }
    const messageBases = new Set(
      [
        messageBase,
        this.currentAssistantAPIMessageId,
        this.activeTurnId
      ].filter(Boolean)
    );
    let tailCandidate: AssistantSegmentState | undefined;
    for (const segment of this.assistantSegmentsByKey.values()) {
      if (
        segment.kind === kind &&
        !usedSegmentIds.has(segment.messageId) &&
        messageBases.has(segment.messageBase) &&
        segment.snapshot === content
      ) {
        return segment;
      }
      if (
        !tailCandidate &&
        segment.kind === kind &&
        !segment.completed &&
        !usedSegmentIds.has(segment.messageId) &&
        messageBases.has(segment.messageBase) &&
        content.startsWith(segment.snapshot)
      ) {
        tailCandidate = segment;
      }
    }
    return tailCandidate;
  }

  private handleContentBlockStart(
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
      this.ensureLiveAssistantSegment(streamEvent.index, "assistant");
      return;
    }
    if (!parentToolUseID && block.type === "thinking") {
      this.ensureLiveAssistantSegment(streamEvent.index, "thinking");
      return;
    }
    if (!isToolUseBlock(block)) {
      return;
    }
    this.upsertToolUse(
      block,
      streamEvent.index,
      "tool_started",
      parentToolUseID
    );
  }

  private handleContentBlockStop(streamEvent: { index?: number }): void {
    if (typeof streamEvent.index !== "number") {
      return;
    }
    const segment = this.assistantSegmentForIndex(streamEvent.index);
    if (segment) {
      this.completeAssistantSegment(streamEvent.index, segment);
      return;
    }
    const tool = this.toolByIndex.get(streamEvent.index);
    if (!tool) {
      return;
    }
    this.emitToolEvent("tool_updated", tool, "streaming");
  }

  private handleToolInputDelta(index: unknown, partialJSON: unknown): void {
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

  private handleAssistantContentBlock(
    block: Record<string, unknown>,
    parentToolUseID = "",
    messageId = "",
    usedSegmentIds = new Set<string>()
  ): void {
    if (isThinkingBlock(block)) {
      if (parentToolUseID) {
        return;
      }
      const thinking = stringValue(block.thinking);
      if (thinking) {
        const existing = this.assistantSegmentWithContent(
          "thinking",
          messageId,
          thinking,
          usedSegmentIds
        );
        if (existing) {
          this.completeAssistantSegment(undefined, existing, thinking);
          usedSegmentIds.add(existing.messageId);
          return;
        }
        const segment = this.ensureFallbackAssistantSegment(
          "thinking",
          messageId
        );
        this.completeAssistantSegment(undefined, segment, thinking);
        usedSegmentIds.add(segment.messageId);
      }
      return;
    }
    if (block.type === "text") {
      if (parentToolUseID) {
        return;
      }
      const text = stringValue(block.text);
      if (text) {
        const existing = this.assistantSegmentWithContent(
          "assistant",
          messageId,
          text,
          usedSegmentIds
        );
        if (existing) {
          this.completeAssistantSegment(undefined, existing, text);
          usedSegmentIds.add(existing.messageId);
          return;
        }
        const segment = this.ensureFallbackAssistantSegment(
          "assistant",
          messageId
        );
        this.completeAssistantSegment(undefined, segment, text);
        usedSegmentIds.add(segment.messageId);
      }
      return;
    }
    if (isToolUseBlock(block)) {
      this.upsertToolUse(block, undefined, "tool_updated", parentToolUseID);
    }
  }

  private handleUserContentBlock(
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

  private async handlePostToolUseHook(
    input: unknown,
    toolUseID?: string
  ): Promise<{ continue: boolean }> {
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

  private async handleTaskLifecycleHook(
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
      if (!subject || this.claudeTasks.has(taskID)) {
        return { continue: true };
      }
      this.claudeTasks.set(taskID, {
        id: taskID,
        subject,
        description: stringValue(hookInput.task_description) || undefined,
        status: "pending"
      });
      this.bindDelegatedTaskIDFromHook(taskID, hookInput);
      this.emitTaskPlanUpdated();
      return { continue: true };
    }
    if (hookInput.hook_event_name === "TaskCompleted") {
      this.bindDelegatedTaskIDFromHook(taskID, hookInput);
      this.emitDelegatedTaskCompletedFromHook(hookInput);
      const existing = this.claudeTasks.get(taskID);
      if (!existing || existing.status === "completed") {
        return { continue: true };
      }
      this.claudeTasks.set(taskID, { ...existing, status: "completed" });
      this.emitTaskPlanUpdated();
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
    const taskId = stringValue(hookInput.task_id) || task.taskId;
    if (taskId && !task.taskId) {
      task.taskId = taskId;
      this.delegatedParentByTaskID.set(taskId, task.parentToolUseId);
    }
    task.status = delegatedTaskStatus(hookInput.status);
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

  private completeDelegatedTaskFromResultMessage(
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

  private completeDelegatedTaskFromParentMessage(
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
    task.status = delegatedTaskStatus(message.status);
    this.emitDelegatedTaskLifecycleEvent("task_completed", task, message);
    this.emitDelegatedTaskParentUpdate(task, message);
  }

  private isNestedDelegatedTaskTerminalAssistant(message: SDKMessage): boolean {
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

  private extractAssistantTextFromMessage(message: SDKMessage): string {
    return contentBlocksFromMessage(message)
      .flatMap((block) =>
        block.type === "text" && stringValue(block.text)
          ? [stringValue(block.text) as string]
          : []
      )
      .join("\n")
      .trim();
  }

  private emitTaskPlanUpdated(): void {
    emit({
      type: "plan_updated",
      payload: {
        turnId: this.activeTurnId,
        entries: [...this.claudeTasks.values()].map((task) => ({
          id: task.id,
          content: task.subject,
          status: task.status,
          ...(task.description ? { description: task.description } : {})
        }))
      }
    });
  }

  private handleToolProgress(
    message: Record<string, unknown>,
    parentToolUseID = ""
  ): void {
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

  private upsertToolUse(
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
    const payload = toolPayload(
      this.resolveToolEventTurnId(tool),
      tool,
      status,
      result
    );
    if (type === "tool_completed" || type === "tool_failed") {
      this.appendParentTaskStep(tool, payload);
      this.rememberDelegatedTaskFromToolPayload(tool, payload);
    }
    emit({
      type,
      payload
    });
  }

  private resolveToolEventTurnId(tool: ToolState): string {
    if (this.activeTurnId) {
      return this.activeTurnId;
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
        this.activeTurnId ||
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
      (task) => task.turnId === this.activeTurnId && task.status === "running"
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

  private hasUnsettledChildWork(parentToolUseId: string): boolean {
    return (
      this.hasPendingChildToolResults(parentToolUseId) ||
      this.hasRunningChildDelegatedTasks(parentToolUseId)
    );
  }

  private hasPendingChildToolResults(parentToolUseId: string): boolean {
    for (const tool of this.toolByID.values()) {
      if (tool.parentToolUseId === parentToolUseId) {
        return true;
      }
    }
    return false;
  }

  private emitDelegatedTaskParentUpdate(
    task: DelegatedTaskState,
    message: Record<string, unknown>
  ): void {
    const turnId = task.turnId || this.activeTurnId;
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
    emit({
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
    const turnId = task.turnId || this.activeTurnId;
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
    emit({
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

  private emitGoalStatusFromBlocks(
    blocks: ReadonlyArray<Record<string, unknown>>
  ): void {
    const goal = goalStateFromContentBlocks(blocks);
    if (!goal) {
      return;
    }
    emit({
      type: "goal_updated",
      payload: {
        turnId: this.activeTurnId,
        updateType: "thread_goal_update",
        goal
      }
    });
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

const sessions = new Map<string, SessionRuntime>();

async function handleRequest(request: RequestEnvelope): Promise<void> {
  const id = typeof request.id === "string" ? request.id : undefined;
  try {
    switch (request.type) {
      case "start": {
        const payload = request.payload ?? {};
        const agentSessionId = stringValue(payload.agentSessionId);
        const providerSessionId =
          stringValue(payload.providerSessionId) || crypto.randomUUID();
        const session = new SessionRuntime(
          providerSessionId,
          stringValue(payload.cwd),
          envObject(payload.env),
          booleanValue(payload.restore),
          process.env.TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER === "1",
          sidecarSessionSettings(payload),
          sidecarClaudeOptionsFromPayload(payload),
          recordValue(payload.resumeCursor) ?? undefined
        );
        sessions.set(agentSessionId, session);
        await session.start();
        emit({
          id,
          type: "ok",
          payload: { providerSessionId: session.providerSessionId }
        });
        return;
      }
      case "exec": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        session.exec(
          stringValue(payload.turnId),
          // Prefer structured content; prompt is the legacy text fallback.
          stringValue(payload.prompt),
          payload.content
        );
        emit({ id, type: "ok" });
        return;
      }
      case "cancel": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        await session.cancel();
        emit({ id, type: "ok" });
        return;
      }
      case "submit_interactive": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        session.submitInteractive(
          stringValue(payload.requestId),
          stringValue(payload.action),
          stringValue(payload.optionId),
          recordValue(payload.payload) ?? {}
        );
        emit({ id, type: "ok" });
        return;
      }
      case "apply_settings": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        await session.applySettings(payload);
        emit({ id, type: "ok" });
        return;
      }
      case "close": {
        const payload = request.payload ?? {};
        const agentSessionId = stringValue(payload.agentSessionId);
        const session = sessions.get(agentSessionId);
        session?.close();
        sessions.delete(agentSessionId);
        emit({ id, type: "ok" });
        return;
      }
      default:
        throw new Error(`unsupported request type ${request.type ?? ""}`);
    }
  } catch (error) {
    emit({
      id,
      type: "error",
      payload: {
        error: errorMessage(error)
      }
    });
  }
}

function requireSession(agentSessionId: string): SessionRuntime {
  const session = sessions.get(agentSessionId);
  if (!session) {
    throw new Error(`session ${agentSessionId} is not started`);
  }
  return session;
}

let sidecarEventSink = (event: SidecarEvent): void => {
  stdout.write(`${JSON.stringify(event)}\n`);
};

export function withSidecarEventSinkForTest(
  sink: (event: SidecarEvent) => void
): () => void {
  sidecarEventSink = sink;
  return () => {
    sidecarEventSink = (event: SidecarEvent): void => {
      stdout.write(`${JSON.stringify(event)}\n`);
    };
  };
}

function emit(event: SidecarEvent): void {
  sidecarEventSink(event);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function envObject(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function booleanValue(value: unknown): boolean {
  return value === true;
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

function sidecarSessionSettings(
  payload: Record<string, unknown>
): SidecarSessionSettings {
  const settings = recordValue(payload.settings) ?? {};
  return {
    model: stringValue(settings.model),
    permissionModeId:
      stringValue(payload.permissionModeId) ||
      stringValue(settings.permissionModeId) ||
      "default",
    planMode: booleanValue(settings.planMode),
    effort:
      stringValue(payload.effort) ||
      stringValue(settings.effort) ||
      stringValue(settings.reasoningEffort),
    speed: stringValue(settings.speed)
  };
}

function effectivePermissionMode(
  settings: SidecarSessionSettings
): PermissionMode | undefined {
  if (settings.planMode) {
    return "plan";
  }
  const permissionMode = permissionModeValue(settings.permissionModeId);
  if (permissionMode === "bypassPermissions" && !canBypassPermissions()) {
    return "default";
  }
  return permissionMode;
}

function permissionModeValue(value: string): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
    case "auto":
      return value;
    default:
      return undefined;
  }
}

function modelOptionValue(value: string): string | undefined {
  const model = stringValue(value);
  return model && model !== "default" ? model : undefined;
}

function sidecarModelOptionsFromInitializationResult(
  value: Record<string, unknown>
): SidecarConfigOption["options"] {
  const rawModels = Array.isArray(value.models) ? value.models : [];
  const options: SidecarConfigOption["options"] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    const model = recordValue(item);
    if (!model) {
      continue;
    }
    const modelValue =
      stringValue(model.value) ||
      stringValue(model.id) ||
      stringValue(model.modelId) ||
      stringValue(model.model_id);
    if (!modelValue || seen.has(modelValue)) {
      continue;
    }
    seen.add(modelValue);
    const name =
      stringValue(model.displayName) ||
      stringValue(model.display_name) ||
      stringValue(model.name) ||
      modelValue;
    const description = stringValue(model.description);
    options.push({
      value: modelValue,
      name,
      ...(description ? { description } : {})
    });
  }
  return options;
}

function defaultSidecarModelOptionValue(
  options: SidecarConfigOption["options"]
): string {
  return (
    options.find((option) => option.value === "default")?.value ??
    options[0]?.value ??
    "default"
  );
}

function effortLevelValue(value: string): Settings["effortLevel"] | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return null;
  }
}

function flagSettingsFromSessionSettings(
  settings: SidecarSessionSettings
): PendingFlagSettings {
  const result: PendingFlagSettings = {};
  if (settings.effort) {
    result.effortLevel = effortLevelValue(settings.effort);
  }
  if (settings.speed === "fast") {
    result.fastMode = true;
  } else if (settings.speed === "standard") {
    result.fastMode = false;
  }
  return result;
}

function querySettingsFromSessionSettings(
  settings: SidecarSessionSettings
): Partial<Settings> {
  const result: Partial<Settings> = {};
  if (settings.speed === "fast") {
    result.fastMode = true;
  } else if (settings.speed === "standard") {
    result.fastMode = false;
  }
  return result;
}

function approvalOptions(): Array<Record<string, unknown>> {
  return [
    {
      kind: "allow_always",
      name: "Allow for session",
      optionId: "allow_always"
    },
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Reject", optionId: "reject" }
  ];
}

function exitPlanOptions(): Array<Record<string, unknown>> {
  const options = [
    {
      kind: "allow_always",
      name: 'Yes, and use "auto" mode',
      optionId: "auto"
    },
    {
      kind: "allow_always",
      name: "Yes, and auto-accept edits",
      optionId: "acceptEdits"
    },
    {
      kind: "allow_once",
      name: "Yes, and manually approve edits",
      optionId: "default"
    },
    { kind: "reject_once", name: "No, keep planning", optionId: "plan" }
  ];
  if (canBypassPermissions()) {
    options.unshift({
      kind: "allow_always",
      name: "Yes, and bypass permissions",
      optionId: "bypassPermissions"
    });
  }
  return options;
}

function isAllowOption(optionId: string): boolean {
  return [
    "allow",
    "allow_always",
    "accept",
    "acceptEdits",
    "default",
    "auto",
    "bypassPermissions"
  ].includes(optionId);
}

function isExitPlanAllowOption(optionId: string): boolean {
  if (optionId === "bypassPermissions") {
    return canBypassPermissions();
  }
  return ["default", "acceptEdits", "auto"].includes(optionId);
}

function canBypassPermissions(): boolean {
  const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0;
  return !isRoot || !!process.env.IS_SANDBOX;
}

function mergeToolResult(
  result: Record<string, unknown>,
  hookResult: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!hookResult) {
    return result;
  }
  return {
    ...result,
    ...hookResult,
    _meta: {
      ...(recordValue(result._meta) ?? {}),
      ...(recordValue(hookResult._meta) ?? {})
    }
  };
}

function isDiffToolResponse(
  value: Record<string, unknown> | undefined
): value is Record<string, unknown> {
  return Boolean(
    value &&
    stringValue(value.filePath) &&
    Array.isArray(value.structuredPatch) &&
    value.structuredPatch.length > 0
  );
}

function readSDKSessionID(message: SDKMessage): string {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" ? value : "";
}

function readSDKMessageUuid(message: SDKMessage): string {
  const value = (message as { uuid?: unknown }).uuid;
  return typeof value === "string" ? value : "";
}

function readSDKAssistantUuid(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }
  return readSDKMessageUuid(message);
}

function readSDKAssistantMessageID(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }
  const inner = (message as { message?: unknown }).message;
  const record = recordValue(inner);
  return stringValue(record?.id);
}

function assistantSegmentIndexKey(
  kind: AssistantSegmentKind,
  index: number
): string {
  return `${kind}:${index}`;
}

function readSDKParentToolUseID(message: SDKMessage): string {
  const value = (message as { parent_tool_use_id?: unknown })
    .parent_tool_use_id;
  return typeof value === "string" ? value.trim() : "";
}

function taskStepFromToolPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: stringValue(payload.toolCallId) || stringValue(payload.callId),
    toolUseId: stringValue(payload.toolCallId) || stringValue(payload.callId),
    toolName: stringValue(payload.toolName),
    name: stringValue(payload.name) || stringValue(payload.toolName),
    callType: stringValue(payload.callType),
    status: stringValue(payload.status),
    toolInput: recordValue(payload.input),
    toolResult: recordValue(payload.output),
    toolError: recordValue(payload.error),
    payload: {
      input: recordValue(payload.input),
      output: recordValue(payload.output),
      error: recordValue(payload.error),
      content: Array.isArray(payload.content) ? payload.content : undefined,
      locations: Array.isArray(payload.locations)
        ? payload.locations
        : undefined
    },
    metadata: recordValue(payload.metadata),
    content: Array.isArray(payload.content) ? payload.content : undefined,
    locations: Array.isArray(payload.locations) ? payload.locations : undefined
  };
}

function normalizeResumeCursor(
  value: Record<string, unknown> | undefined,
  providerSessionId: string
): Record<string, unknown> | undefined {
  const resume = stringValue(value?.resume) || providerSessionId;
  if (!resume) {
    return undefined;
  }
  return {
    kind: "claude-agent-sdk",
    version: 1,
    resume,
    ...(stringValue(value?.resumeSessionAt)
      ? { resumeSessionAt: stringValue(value?.resumeSessionAt) }
      : {}),
    turnCount: numberValue(value?.turnCount)
  };
}

function abortError(): Error {
  const error = new Error("Claude SDK turn interrupted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("interrupted"))
  );
}

function emitUsageUpdated(
  turnId: string,
  payload: Record<string, unknown>
): void {
  const cleaned: Record<string, unknown> = { turnId };
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  if (Object.keys(cleaned).length <= 1) {
    return;
  }
  emit({
    type: "usage_updated",
    payload: cleaned
  });
}

function contextWindowTokensFromModelUsage(value: unknown): number {
  if (Array.isArray(value)) {
    for (const item of value) {
      const tokens = contextWindowTokensFromModelUsage(item);
      if (tokens > 0) {
        return tokens;
      }
    }
    return 0;
  }
  const record = recordValue(value);
  if (!record) {
    return 0;
  }
  for (const key of [
    "maxTokens",
    "max_tokens",
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "modelContextWindow",
    "model_context_window",
    "size",
    "limit",
    "max"
  ]) {
    const tokens = numberValue(record[key]);
    if (tokens > 0) {
      return tokens;
    }
  }
  for (const nested of Object.values(record)) {
    if (typeof nested !== "object" || nested === null) {
      continue;
    }
    const tokens = contextWindowTokensFromModelUsage(nested);
    if (tokens > 0) {
      return tokens;
    }
  }
  return 0;
}

function isCompactCommandPrompt(value: string): boolean {
  const prompt = value.trim().toLowerCase();
  return prompt === "/compact" || prompt.startsWith("/compact ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  const withCode = error as Error & {
    code?: unknown;
    status?: unknown;
    cause?: unknown;
  };
  if (withCode.code !== undefined) {
    result.code = withCode.code;
  }
  if (withCode.status !== undefined) {
    result.status = withCode.status;
  }
  if (withCode.cause !== undefined) {
    result.cause = errorPayload(withCode.cause);
  }
  if (error.stack) {
    result.stack = error.stack;
  }
  return result;
}

function debugClaudeAuthRefreshLog(
  stage: string,
  payload: Record<string, unknown>
): void {
  try {
    stderr.write(
      `${CLAUDE_AUTH_REFRESH_LOG_PREFIX} ${JSON.stringify({
        stage,
        timestamp: new Date().toISOString(),
        ...payload
      })}\n`
    );
  } catch (error) {
    stderr.write(
      `${CLAUDE_AUTH_REFRESH_LOG_PREFIX} ${JSON.stringify({
        stage: "log_failed",
        timestamp: new Date().toISOString(),
        originalStage: stage,
        error: errorPayload(error)
      })}\n`
    );
  }
}

function claudeCredentialSnapshot(): Record<string, unknown> {
  const now = Date.now();
  if (
    cachedClaudeCredentialSnapshot &&
    now - cachedClaudeCredentialSnapshot.capturedAtMs <=
      CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
  ) {
    return {
      ...cachedClaudeCredentialSnapshot.snapshot,
      cache: {
        hit: true,
        ageMs: now - cachedClaudeCredentialSnapshot.capturedAtMs,
        ttlMs: CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
      }
    };
  }
  const configDir = claudeConfigDir();
  const keychain = claudeKeychainCredentialSnapshot(configDir);
  const plaintext = claudePlaintextCredentialSnapshot(configDir);
  const effectiveSource =
    keychain.found && keychain.hasAccessToken
      ? "keychain"
      : plaintext.found && plaintext.hasAccessToken
        ? "plaintext"
        : "none";
  const snapshot = {
    storageBackend:
      process.platform === "darwin"
        ? "keychain-with-plaintext-fallback"
        : "plaintext",
    configDir,
    configDirDefault: !process.env.CLAUDE_CONFIG_DIR,
    effectiveSource,
    keychain,
    plaintext,
    cache: {
      hit: false,
      ageMs: 0,
      ttlMs: CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
    }
  };
  cachedClaudeCredentialSnapshot = {
    capturedAtMs: now,
    snapshot
  };
  return snapshot;
}

function claudeKeychainCredentialSnapshot(
  configDir: string
): Record<string, unknown> {
  if (process.platform !== "darwin") {
    return { checked: false, reason: "non_darwin" };
  }
  const serviceName = claudeKeychainServiceName(configDir);
  const account = claudeKeychainAccount();
  try {
    const content = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-w", "-s", serviceName],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000
      }
    ).trim();
    return {
      checked: true,
      serviceName,
      account,
      found: Boolean(content),
      ...credentialContentSnapshot(content)
    };
  } catch (error) {
    return {
      checked: true,
      serviceName,
      account,
      found: false,
      error: credentialProbeErrorPayload(error)
    };
  }
}

function claudePlaintextCredentialSnapshot(
  configDir: string
): Record<string, unknown> {
  const path = `${configDir}/.credentials.json`;
  try {
    const stat = statSync(path);
    return {
      path,
      found: true,
      mtimeMs: stat.mtimeMs,
      mtimeISO: stat.mtime.toISOString(),
      ...credentialContentSnapshot(readFileSync(path, "utf8"))
    };
  } catch (error) {
    return {
      path,
      found: false,
      error: credentialProbeErrorPayload(error)
    };
  }
}

function credentialContentSnapshot(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const oauth = recordValue(parsed.claudeAiOauth) ?? {};
    const expiresAt = numberValue(oauth.expiresAt);
    return {
      topLevelKeys: Object.keys(parsed),
      oauthKeys: Object.keys(oauth),
      hasAccessToken: Boolean(stringValue(oauth.accessToken)),
      hasRefreshToken: Boolean(stringValue(oauth.refreshToken)),
      expiresAt,
      expiresAtISO: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt > 0 ? expiresAt <= Date.now() : null
    };
  } catch (error) {
    return {
      parseError: credentialProbeErrorPayload(error)
    };
  }
}

function credentialProbeErrorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const withCode = error as Error & {
    code?: unknown;
    status?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(withCode.code !== undefined ? { code: withCode.code } : {}),
    ...(withCode.status !== undefined ? { status: withCode.status } : {})
  };
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
}

function claudeKeychainAccount(): string {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

function claudeKeychainServiceName(configDir: string): string {
  const dirHash = process.env.CLAUDE_CONFIG_DIR
    ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code${claudeOAuthFileSuffix()}-credentials${dirHash}`;
}

function claudeOAuthFileSuffix(): string {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return "-custom-oauth";
  }
  if (process.env.USER_TYPE === "ant") {
    if (truthyEnv(process.env.USE_LOCAL_OAUTH)) {
      return "-local-oauth";
    }
    if (truthyEnv(process.env.USE_STAGING_OAUTH)) {
      return "-staging-oauth";
    }
  }
  return "";
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function runMain(): Promise<void> {
  const lines = readline.createInterface({ input: stdin });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      await handleRequest(JSON.parse(line) as RequestEnvelope);
    } catch (error) {
      emit({
        type: "error",
        payload: {
          error: errorMessage(error)
        }
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runMain();
}
