import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  contentBlocksFromMessage,
  isToolUseBlock,
  recordValue
} from "./normalizer.ts";
import { ClaudeGoalProjection } from "./goalProjection.ts";
import { ClaudeGoalTranscript } from "./goalTranscript.ts";
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
import type { ProviderTurnPhase } from "./providerTurnAcceptance.ts";

type ObservableProviderTurnPhase = Extract<
  ProviderTurnPhase,
  "streaming" | "running_tool"
>;

const NON_DURABLE_SYSTEM_CHECKPOINT_SUBTYPES = new Set([
  "session_state_changed",
  "hook_started",
  "hook_progress",
  "hook_response"
]);

export class SDKMessageRouter {
  private readonly getProviderSessionId: () => string;
  private readonly setProviderSessionId: (value: string) => void;
  private readonly onAssistantUuid: (value: string) => void;
  private readonly onRuntimeModel: (value: string) => void;
  private readonly onSessionState: () => void;
  private readonly onMaybeTitle: (shouldEmit?: () => boolean) => Promise<void>;
  private readonly onTerminalConnectionError: () => void;
  private readonly turns: TurnLifecycle;
  private readonly assistant: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly projection: MessageProjection;
  private readonly compaction: CompactionTracker;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly goals: ClaudeGoalProjection;
  private readonly goalTranscript: ClaudeGoalTranscript;
  private readonly resolveGoalTranscriptPath: (
    sessionId: string,
    cwd: string
  ) => string;
  private readonly emitProviderCheckpointEvent: (
    turnId: string,
    providerTurnId: string,
    providerCheckpointMessageId: string
  ) => void;
  private readonly ensureProviderTurnAcceptance: (
    phase: ObservableProviderTurnPhase
  ) => Promise<void>;
  private readonly peekGuidanceInterrupt: () => boolean;
  private readonly clearGuidanceInterrupt: () => void;
  private contextUsageGeneration = 0;
  private activeRootAssistantError = "";
  private activeRootConnectionRetry = false;

  constructor(options: {
    getProviderSessionId: () => string;
    setProviderSessionId: (value: string) => void;
    onAssistantUuid: (value: string) => void;
    onRuntimeModel: (value: string) => void;
    onSessionState: () => void;
    onMaybeTitle: (shouldEmit?: () => boolean) => Promise<void>;
    onTerminalConnectionError: () => void;
    turns: TurnLifecycle;
    assistant: AssistantStreamProjector;
    activities: ToolActivityProjector;
    projection: MessageProjection;
    compaction: CompactionTracker;
    emit: ClaudeSDKSidecarEventEmitter;
    emitProviderCheckpoint: (
      turnId: string,
      providerTurnId: string,
      providerCheckpointMessageId: string
    ) => void;
    ensureProviderTurnAcceptance: (
      phase: ObservableProviderTurnPhase
    ) => Promise<void>;
    /**
     * guide()-initiated interrupt is pending. The next root result should
     * clear it; an error_during_execution result must not settle the turn.
     */
    peekGuidanceInterrupt?: () => boolean;
    clearGuidanceInterrupt?: () => void;
    resolveGoalTranscriptPath: (sessionId: string, cwd: string) => string;
  }) {
    this.getProviderSessionId = options.getProviderSessionId;
    this.setProviderSessionId = options.setProviderSessionId;
    this.onAssistantUuid = options.onAssistantUuid;
    this.onRuntimeModel = options.onRuntimeModel;
    this.onSessionState = options.onSessionState;
    this.onMaybeTitle = options.onMaybeTitle;
    this.onTerminalConnectionError = options.onTerminalConnectionError;
    this.turns = options.turns;
    this.assistant = options.assistant;
    this.activities = options.activities;
    this.projection = options.projection;
    this.compaction = options.compaction;
    this.emit = options.emit;
    this.goals = new ClaudeGoalProjection(options.turns, options.emit);
    this.goalTranscript = new ClaudeGoalTranscript((message) => {
      this.goals.handle(message);
    });
    this.emitProviderCheckpointEvent = options.emitProviderCheckpoint;
    this.ensureProviderTurnAcceptance = options.ensureProviderTurnAcceptance;
    this.peekGuidanceInterrupt = options.peekGuidanceInterrupt ?? (() => false);
    this.clearGuidanceInterrupt =
      options.clearGuidanceInterrupt ?? (() => undefined);
    this.resolveGoalTranscriptPath = options.resolveGoalTranscriptPath;
  }

  async handle(message: SDKMessage): Promise<void> {
    const parentToolUseID = readSDKParentToolUseID(message);
    const runtimeModel = readRuntimeModel(message, parentToolUseID);
    if (runtimeModel) {
      this.onRuntimeModel(runtimeModel);
    }
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

    const rawMessage = message as unknown as Record<string, unknown>;
    const systemSubtype =
      message.type === "system" ? stringValue(rawMessage.subtype) : "";
    if (
      !parentToolUseID &&
      sessionId &&
      (systemSubtype === "init" || systemSubtype === "compact_boundary")
    ) {
      await this.observeRootSession(sessionId, stringValue(rawMessage.cwd));
    }
    if (this.goals.handle(rawMessage)) {
      return;
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
      const raw = message as unknown as Record<string, unknown>;
      const sdkErrorStatus =
        typeof raw.error_status === "number" ? raw.error_status : undefined;
      const sdkAssistantError = stringValue(raw.error);
      if (
        systemSubtype === "api_retry" &&
        !parentToolUseID &&
        (sdkErrorStatus === 401 ||
          sdkAssistantError === "authentication_failed")
      ) {
        // Claude reports an invalid API key as a system api_retry before it
        // emits the later assistant/result pair. A 401 is definitive, so do
        // not let the SDK spend several minutes retrying a turn that has not
        // crossed the provider-acceptance boundary.
        const turn = this.turns.ensureActive("api_retry");
        if (turn && !this.turns.lastProviderTurnId.trim()) {
          this.activeRootAssistantError = "authentication_failed";
          this.turns.settleActive("turn_failed", {
            error: "Claude authentication failed",
            code: "authentication_failed",
            apiErrorStatus: 401,
            dispatchDisposition: "rejected"
          });
          this.onTerminalConnectionError();
        }
        return;
      }
      if (
        systemSubtype === "api_retry" &&
        raw.error_status === null &&
        this.turns.activeId
      ) {
        this.activeRootConnectionRetry = true;
      }
      if (
        systemSubtype === "session_state_changed" &&
        stringValue(raw.state) === "idle" &&
        !parentToolUseID
      ) {
        // idle is Claude's final evaluator boundary. Drain the transcript one
        // last time before deciding that an active Goal has no terminal
        // verdict; a goal_status written just before idle must win.
        await this.goalTranscript.drain();
        this.goals.handleProviderIdle();
        if (this.activities.clearBackgroundContinuation()) {
          this.turns.settleActive("turn_completed", {
            stopReason: "background_agent_idle"
          });
        }
      }
      this.projection.handleSystemMessage(raw);
      // session_state_changed is an SDK live-state notification. It can carry
      // a UUID, but Claude does not persist it in the transcript accepted by
      // forkSession(upToMessageId). Persisting that UUID would overwrite the
      // preceding durable assistant checkpoint with an unforkable boundary.
      // Hook lifecycle notifications are also UUID-stamped system messages,
      // but includeHookEvents exposes these exact subtypes only for live
      // progress. They are not durable transcript boundaries and must not
      // become fork cursors. Other system boundaries remain durable.
      if (!NON_DURABLE_SYSTEM_CHECKPOINT_SUBTYPES.has(systemSubtype)) {
        this.emitProviderCheckpoint(message, parentToolUseID);
      }
      return;
    }

    if (message.type === "stream_event") {
      if (!parentToolUseID) {
        await this.ensureProviderTurnAcceptance("streaming");
      }
      this.handleStreamEvent(message, parentToolUseID);
      return;
    }

    if (message.type === "assistant") {
      const assistantError = stringValue(
        (message as unknown as Record<string, unknown>).error
      );
      if (
        !parentToolUseID &&
        assistantError === "authentication_failed" &&
        !this.turns.lastProviderTurnId.trim()
      ) {
        // An SDK-level failure can arrive before Claude persists the root user
        // message. Retain the structured failure for the terminal result, but
        // do not enter identity recovery or publish provider output that has
        // no durably accepted provider Turn.
        if (this.turns.ensureActive("assistant")) {
          this.activeRootAssistantError = assistantError;
          const failureText =
            contentBlocksFromMessage(message)
              .filter((block) => block.type === "text")
              .map((block) => stringValue(block.text))
              .find((text) => text.trim()) || "Claude authentication failed";
          // Authentication failures are definitive before Claude has created
          // a provider Turn. Settle locally and retire the query immediately;
          // waiting for the SDK's later result would leave the Host waiting on
          // an acceptance barrier while the SDK retries the same request.
          this.turns.settleActive("turn_failed", {
            error: failureText,
            code: assistantError,
            apiErrorStatus: 401,
            dispatchDisposition: "rejected"
          });
          this.onTerminalConnectionError();
        }
        return;
      }
      if (!parentToolUseID) {
        await this.ensureProviderTurnAcceptance("streaming");
      }
      this.handleAssistant(message, parentToolUseID);
      this.emitProviderCheckpoint(message, parentToolUseID);
      return;
    }

    if (message.type === "user") {
      if (isTuttiHostContextUserMessage(message)) {
        return;
      }
      this.handleUser(message, parentToolUseID);
      this.emitProviderCheckpoint(message, parentToolUseID);
      return;
    }

    if (message.type === "tool_progress") {
      if (!parentToolUseID) {
        await this.ensureProviderTurnAcceptance("running_tool");
      }
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
      if (!parentToolUseID) {
        // The local SDK stream drops goal_status attachments. Drain the
        // provider transcript before settling the root Turn so downstream
        // Goal state observes the terminal evidence in causal order.
        await this.goalTranscript.drain();
      }
      await this.handleResult(message, parentToolUseID);
    }
  }

  async observeSessionStartHook(input: unknown): Promise<void> {
    const hookInput = recordValue(input);
    const agentId = stringValue(hookInput?.agent_id);
    const transcriptPath = stringValue(hookInput?.transcript_path);
    // Programmatic hooks also run inside delegated agents. Their transcript
    // must never retarget the root Session's Goal observer.
    if (agentId) {
      return;
    }
    if (transcriptPath) {
      await this.goalTranscript.start(transcriptPath);
    }
  }

  async observeRootSession(sessionId: string, cwd: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    const transcriptPath = this.resolveGoalTranscriptPath(
      normalizedSessionId,
      cwd
    );
    await this.goalTranscript.start(transcriptPath);
  }

  async close(): Promise<void> {
    await this.goalTranscript.close();
  }

  trackGoalCommand(action: "set" | "clear", prompt: string): void {
    this.goals.trackGoalCommand(action, prompt);
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
        messageSubtype === "task_updated" ||
        messageSubtype === "background_tasks_changed" ||
        messageSubtype === "session_state_changed");
    const apiRetry = messageType === "system" && messageSubtype === "api_retry";
    const rootContinuationCandidate =
      messageType === "assistant" &&
      !parentToolUseID &&
      (!this.turns.activeId || this.turns.awaitingContinuation);
    const result = messageType === "result";
    if (
      !taskNotification &&
      !systemTaskLifecycle &&
      !apiRetry &&
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
        ...(apiRetry ? { apiRetry: true } : {}),
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
        ...(stringValue(raw.state) ? { state: stringValue(raw.state) } : {}),
        ...(stringValue(recordValue(raw.origin)?.kind)
          ? { sdkMessageOrigin: stringValue(recordValue(raw.origin)?.kind) }
          : {}),
        ...(raw.is_error === true ? { sdkResultIsError: true } : {}),
        ...(typeof raw.api_error_status === "number"
          ? { sdkApiErrorStatus: raw.api_error_status }
          : {}),
        ...(apiRetry && raw.error_status === null
          ? { sdkConnectionError: true }
          : {}),
        ...(apiRetry && typeof raw.error_status === "number"
          ? { sdkApiErrorStatus: raw.error_status }
          : {}),
        ...(apiRetry && typeof raw.attempt === "number"
          ? { sdkRetryAttempt: raw.attempt }
          : {}),
        ...(apiRetry && typeof raw.max_retries === "number"
          ? { sdkMaxRetries: raw.max_retries }
          : {}),
        ...(apiRetry && typeof raw.retry_delay_ms === "number"
          ? { sdkRetryDelayMs: raw.retry_delay_ms }
          : {}),
        ...(apiRetry && stringValue(raw.error)
          ? { sdkAssistantError: stringValue(raw.error) }
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

  private emitProviderCheckpoint(
    message: SDKMessage,
    parentToolUseID: string
  ): void {
    if (parentToolUseID) {
      return;
    }
    const checkpointMessageId = readSDKMessageUuid(message);
    const turnId = this.turns.lastTurnId.trim();
    const providerTurnId = this.turns.lastProviderTurnId.trim();
    if (!checkpointMessageId || !turnId || !providerTurnId) {
      return;
    }
    // Newer Claude SDK versions can omit the echoed root user message that
    // normally binds Provider identity. The first durable root checkpoint is
    // still Provider evidence, so announce the turn before its checkpoint.
    this.turns.confirmProviderTurnStarted(providerTurnId);
    this.emitProviderCheckpointEvent(
      turnId,
      providerTurnId,
      checkpointMessageId
    );
  }

  private handleUser(message: SDKMessage, parentToolUseID: string): void {
    const notificationText = readUserMessageNotificationText(
      message as { message?: { content?: unknown } }
    );
    const taskNotification = notificationText.includes("<task-notification>");
    if (taskNotification) {
      this.activities.handleTaskNotificationFromText(notificationText);
    }
    const activeTurnIdBefore = this.turns.activeId;
    if (!parentToolUseID && !taskNotification) {
      this.turns.activateForUserMessage(readSDKMessageUuid(message));
    } else {
      this.turns.ensureActive("user");
    }
    if (
      !parentToolUseID &&
      this.turns.activeId &&
      this.turns.activeId !== activeTurnIdBefore
    ) {
      this.activities.beginRootTurn();
      this.contextUsageGeneration += 1;
      this.activeRootAssistantError = "";
      this.activeRootConnectionRetry = false;
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
      origin?: { kind?: string };
    };
    this.projection.emitFastModeState(
      (message as unknown as Record<string, unknown>).fast_mode_state
    );
    if (
      this.turns.consumeTimedOutContinuationResult() ||
      this.turns.consumePendingOrphan()
    ) {
      return;
    }
    const assistantError = this.activeRootAssistantError;
    const rejectedBeforeAcceptance =
      !this.turns.lastProviderTurnId.trim() &&
      result.is_error === true &&
      (result.api_error_status === 401 ||
        assistantError === "authentication_failed");
    if (!rejectedBeforeAcceptance) {
      await this.ensureProviderTurnAcceptance("streaming");
    }
    if (!this.turns.ensureActive("result")) {
      return;
    }
    const turnId = this.turns.activeId;
    const contextUsageGeneration = this.contextUsageGeneration;
    const terminalConnectionError =
      result.is_error === true &&
      (result.api_error_status === null ||
        (result.api_error_status === undefined &&
          this.activeRootConnectionRetry));
    this.activeRootAssistantError = "";
    this.activeRootConnectionRetry = false;
    if (terminalConnectionError) {
      this.onTerminalConnectionError();
    }
    const succeeded =
      !this.turns.cancelled &&
      result.subtype === "success" &&
      result.is_error !== true &&
      !assistantError;
    const taskNotificationResult = result.origin?.kind === "task-notification";
    if (succeeded && taskNotificationResult) {
      this.activities.markTaskNotificationContinuation();
      void this.emitResultUsage(turnId, contextUsageGeneration, result);
      return;
    }
    if (succeeded) {
      // A successful provider result is authoritative that a root
      // run_in_background invocation launched. Close the launch tool before
      // the root terminal even when the SDK's task_started notification is
      // delayed; the detached process itself remains independently stoppable.
      this.activities.completePendingRootBackgroundLaunches();
    }
    const pendingBackgroundContinuation =
      succeeded && this.activities.hasPendingBackgroundContinuation();
    const completedSyntheticContinuation =
      pendingBackgroundContinuation &&
      this.turns.activeTurn?.synthetic === true;
    // When the background level or task notifications already proved that
    // follow-up output is pending, a successful root result is only the end of
    // that provider response—not the canonical turn. Keep the original turn
    // live until session idle instead of emitting a terminal/start pair that
    // can settle durable state between the two events.
    const retainRootForBackgroundContinuation =
      pendingBackgroundContinuation &&
      this.turns.activeTurn?.synthetic !== true;
    if (this.turns.cancelled) {
      this.clearGuidanceInterrupt();
      this.turns.settleActive("turn_canceled");
      this.turns.clearCancelled();
    } else if (!succeeded) {
      // guide() interrupts in-flight tool work before enqueueing steer text.
      // Claude reports that abort as error_during_execution; settling here
      // would end the canonical turn and force a synthetic continuation that
      // record/replay cannot close with turn.terminal (C06).
      const guidanceInterrupt =
        this.peekGuidanceInterrupt() &&
        result.subtype === "error_during_execution";
      this.clearGuidanceInterrupt();
      if (!guidanceInterrupt) {
        this.turns.settleActive("turn_failed", {
          error:
            result.errors?.[0] ||
            (result.is_error ? result.result : "") ||
            assistantError ||
            "Claude SDK turn failed",
          ...(assistantError ? { code: assistantError } : {}),
          ...(typeof result.api_error_status === "number"
            ? { apiErrorStatus: result.api_error_status }
            : {}),
          ...(rejectedBeforeAcceptance
            ? { dispatchDisposition: "rejected" }
            : {})
        });
      }
    } else if (!retainRootForBackgroundContinuation) {
      this.clearGuidanceInterrupt();
      this.turns.settleActive("turn_completed", { stopReason: "end_turn" });
    } else {
      this.clearGuidanceInterrupt();
    }
    if (completedSyntheticContinuation) {
      this.activities.clearBackgroundContinuation();
    } else {
      this.activities.handleRootResultSettled(succeeded);
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

function readRuntimeModel(
  message: SDKMessage,
  parentToolUseID: string
): string {
  if (parentToolUseID) {
    return "";
  }
  const raw = message as unknown as Record<string, unknown>;
  if (message.type === "system" && stringValue(raw.subtype) === "init") {
    return stringValue(raw.model);
  }
  if (message.type !== "assistant") {
    return "";
  }
  return stringValue(recordValue(raw.message)?.model);
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
