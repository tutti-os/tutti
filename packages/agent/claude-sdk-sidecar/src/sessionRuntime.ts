import type {
  Options as ClaudeQueryOptions,
  PermissionResult,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  numberValue,
  recordValue,
  sdkContentFromPromptBlocks
} from "./normalizer.ts";
import {
  claudeQueryOptionOverrides,
  type SidecarClaudeOptions
} from "./options.ts";
import {
  QueryGeneration,
  type ClaudeQueryRuntime,
  type QueryShutdownOptions
} from "./queryGeneration.ts";
import { queryGenerationHooks } from "./queryHooks.ts";
import { errorMessage, errorPayload } from "./errors.ts";
import { AssistantStreamProjector } from "./assistantStream.ts";
import {
  InteractiveCoordinator,
  type ToolPermissionOptions
} from "./interactive.ts";
import { resolveInteractiveTurnId } from "./interactiveTurnResolver.ts";
import {
  GoalExecQueue,
  type GoalCommandDispatch,
  type GoalExecInput
} from "./goalExecQueue.ts";
import { TurnLifecycle, type RuntimeTurn } from "./turnLifecycle.ts";
import { normalizeTitle, stringValue } from "./runtimeValues.ts";
import {
  abortError,
  isAbortError,
  isCompactCommandPrompt,
  normalizeResumeCursor
} from "./sdkMessages.ts";
import { ToolActivityProjector } from "./toolActivity.ts";
import { SidecarTestDriver } from "./testDriver.ts";
import { SessionConfiguration } from "./sessionConfiguration.ts";
import { resolveClaudeCodeExecutablePath } from "./executablePath.ts";
import { claudeSettingsEnv } from "./settingsEnv.ts";
import { CompactionTracker } from "./compaction.ts";
import { MessageProjection } from "./messageProjection.ts";
import { SDKMessageRouter } from "./messageRouter.ts";
import { claudeGoalTranscriptPath } from "./goalTranscript.ts";
import { emit } from "./eventSink.ts";
import {
  resolveClaudeTurnBindingByRecoveryToken,
  type ClaudeTurnBindingResolver
} from "./sessionFork.ts";
import {
  ProviderTurnAcceptanceCoordinator,
  type ProviderTurnPhase
} from "./providerTurnAcceptance.ts";
import { ClaudeSessionDiagnostics } from "./sessionDiagnostics.ts";
import {
  canBypassPermissions,
  effectivePermissionMode,
  modelOptionValue,
  querySettingsFromSessionSettings,
  type SidecarSessionSettings
} from "./sessionSettings.ts";

type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}) => ClaudeQueryRuntime;

export type SessionCancelDisposition =
  | "pre_accept"
  | "provider_active"
  | "provider_state_lost"
  | "absent"
  | "mismatch";

export type SessionCancelResult = {
  canceled: boolean;
  disposition: SessionCancelDisposition;
  turnId: string;
  providerTurnId: string;
  dispatchPhase: ProviderTurnPhase | "pending_goal" | "unknown";
};

function cancelResult(
  canceled: boolean,
  disposition: SessionCancelDisposition,
  turnId: string,
  providerTurnId = "",
  dispatchPhase: SessionCancelResult["dispatchPhase"] = "unknown"
): SessionCancelResult {
  return {
    canceled,
    disposition,
    turnId: turnId.trim(),
    providerTurnId: providerTurnId.trim(),
    dispatchPhase
  };
}

export class SessionRuntime {
  providerSessionId: string;

  get activeTurnId(): string {
    return this.turns.activeId;
  }
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly restore: boolean;
  private readonly turns: TurnLifecycle;
  private readonly assistantStream: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly compaction: CompactionTracker;
  private readonly projection: MessageProjection;
  private initialized = false;
  private sessionClosed = false;
  private executionEpoch = 0;
  private nextQueryGenerationId = 0;
  private queryGeneration: QueryGeneration | undefined;
  private resumeQueries: boolean;
  private canceledQueryTailPending = false;
  private lastTitle = "";
  private lastAssistantUuid = "";
  private resumeCursor: Record<string, unknown> | undefined;
  private readonly configuration: SessionConfiguration;
  /**
   * Serializes live apply_settings with turn-dispatch applyPendingFlags so a
   * settings write and the next send cannot interleave on the same Claude
   * query (half-applied flags + retired idle generation → submitted silence).
   */
  private configurationGate: Promise<void> = Promise.resolve();
  private readonly claudeOptions: SidecarClaudeOptions;
  private readonly queryFactory?: ClaudeQueryFactory;
  private readonly interactions: InteractiveCoordinator;
  private readonly router: SDKMessageRouter;
  /** Set by guide() before interrupt; consumed by the next error result. */
  private pendingGuidanceInterrupt = false;
  private readonly driver?: SidecarTestDriver;
  private readonly goalExecQueue: GoalExecQueue;
  private readonly providerTurnAcceptance: ProviderTurnAcceptanceCoordinator;
  private readonly diagnostics: ClaudeSessionDiagnostics;
  private readonly emittedProviderCheckpoints = new Set<string>();
  private readonly acceptedProviderTurnIds = new Set<string>();

  get query(): ClaudeQueryRuntime | undefined {
    return this.queryGeneration?.query;
  }

  constructor(
    providerSessionId: string,
    cwd: string,
    env: Record<string, string | undefined>,
    restore: boolean,
    testDriver: boolean,
    settings: SidecarSessionSettings,
    claudeOptions: SidecarClaudeOptions,
    resumeCursor?: Record<string, unknown>,
    queryFactory?: ClaudeQueryFactory,
    continuationStartTimeoutMs = 30_000,
    resolveProviderTurnIdentity: ClaudeTurnBindingResolver = resolveClaudeTurnBindingByRecoveryToken,
    providerTurnIdentityResolutionTimeoutMs = 5_000
  ) {
    const resumeSessionId = stringValue(resumeCursor?.resume);
    this.providerSessionId = resumeSessionId || providerSessionId;
    this.cwd = cwd;
    this.env = env;
    this.restore = restore || resumeSessionId !== "";
    this.resumeQueries = this.restore;
    this.turns = new TurnLifecycle({
      emit,
      onActivate: () => this.resetTurnScratch(),
      onSyntheticActivate: (turnId) =>
        this.queryGeneration?.registerTurn(turnId),
      onSettled: (turnId) => {
        this.acceptedProviderTurnIds.delete(turnId.trim());
        this.providerTurnAcceptance.terminal(turnId);
        this.emitSessionState();
      },
      onProviderTurnIdentityBound: (turnId) => {
        const normalizedTurnId = turnId.trim();
        if (!normalizedTurnId) {
          return;
        }
        this.acceptedProviderTurnIds.add(normalizedTurnId);
        while (this.acceptedProviderTurnIds.size > 64) {
          const oldest = this.acceptedProviderTurnIds.values().next().value;
          if (typeof oldest !== "string") {
            break;
          }
          this.acceptedProviderTurnIds.delete(oldest);
        }
      },
      continuationStartTimeoutMs,
      onContinuationStartTimeout: () => {
        this.activities.clearBackgroundContinuation();
        void this.query?.interrupt?.().catch((error) => {
          emit({
            type: "error",
            payload: {
              error: `Claude SDK continuation interrupt failed: ${errorMessage(error)}`
            }
          });
        });
      }
    });
    this.providerTurnAcceptance = new ProviderTurnAcceptanceCoordinator({
      cwd: this.cwd,
      getProviderSessionId: () => this.providerSessionId,
      resolveTarget: () => {
        const turn =
          this.turns.activeTurn ??
          this.turns.queue.find(
            (candidate) =>
              !candidate.settled &&
              !candidate.synthetic &&
              candidate.awaitingProviderTurnIdentity === true
          );
        if (!turn || turn.synthetic) {
          return undefined;
        }
        return {
          turnId: turn.turnId,
          promptCorrelationId: turn.promptUuid,
          providerTurnId: turn.providerTurnId?.trim() ?? ""
        };
      },
      resolveBinding: resolveProviderTurnIdentity,
      bindIdentity: (turnId, providerTurnId) =>
        this.turns.bindProviderTurnIdentity(turnId, providerTurnId),
      emitCheckpoint: (turnId, binding) =>
        this.emitProviderCheckpoint(
          turnId,
          binding.providerTurnId,
          binding.providerCheckpointMessageId
        ),
      resolutionTimeoutMs: providerTurnIdentityResolutionTimeoutMs
    });
    this.diagnostics = new ClaudeSessionDiagnostics({
      cwd: this.cwd,
      providerSessionId: () => this.providerSessionId,
      turns: () => this.turns.queue,
      phaseForTurn: (turnId) => this.providerTurnAcceptance.phase(turnId)
    });
    this.assistantStream = new AssistantStreamProjector(
      () => this.turns.activeId,
      emit
    );
    this.activities = new ToolActivityProjector(
      () => this.turns.activeId,
      emit,
      () => this.turns.expectSyntheticContinuation(),
      () => this.turns.lastTurnId
    );
    this.compaction = new CompactionTracker({
      activeTurnId: () => this.turns.activeId,
      ensureActive: (messageType) => {
        this.turns.ensureActive(messageType);
      },
      clearPendingOrphans: () => this.turns.clearPendingOrphans(),
      getQuery: () => this.query,
      getModel: () => settings.model,
      emit
    });
    this.projection = new MessageProjection({
      providerSessionId: () => this.providerSessionId,
      turns: this.turns,
      assistant: this.assistantStream,
      activities: this.activities,
      compaction: this.compaction,
      emit
    });
    this.configuration = new SessionConfiguration({
      settings,
      getQuery: () => this.query,
      testDriver,
      isInitialized: () => this.initialized,
      markInitialized: () => {
        this.initialized = true;
      },
      emitFastModeState: (state) => this.projection.emitFastModeState(state)
    });
    this.interactions = new InteractiveCoordinator({
      settings,
      resolveTurnId: (options) =>
        resolveInteractiveTurnId(options, this.turns, this.activities),
      activateSyntheticTurn: () => this.turns.activateSynthetic().turnId,
      ensureProviderTurnAcceptance: (phase, signal) =>
        this.ensureProviderTurnAcceptance(phase, signal),
      emit
    });
    this.driver = testDriver
      ? new SidecarTestDriver(this.turns, this.interactions)
      : undefined;
    this.goalExecQueue = new GoalExecQueue((input) =>
      this.dispatchExec(
        input.turnId,
        input.promptCorrelationId,
        input.prompt,
        input.content,
        input.turnOrigin,
        input.goal,
        input.hostContext
      )
    );
    this.router = new SDKMessageRouter({
      getProviderSessionId: () => this.providerSessionId,
      setProviderSessionId: (value) => {
        this.providerSessionId = value;
      },
      onAssistantUuid: (value) => {
        this.lastAssistantUuid = value;
      },
      onRuntimeModel: (value) => {
        if (this.configuration.applyRuntimeModel(value)) {
          this.emitSessionState();
        }
      },
      onSessionState: () => this.emitSessionState(),
      onMaybeTitle: (shouldEmit) =>
        this.maybeEmitSessionTitleUpdated(shouldEmit),
      onTerminalConnectionError: () =>
        QueryGeneration.retire(this.queryGeneration, () => {
          this.executionEpoch += 1;
          this.turns.failQueuedTurns("Claude SDK connection lost");
          this.queryGeneration = undefined;
        }),
      turns: this.turns,
      assistant: this.assistantStream,
      activities: this.activities,
      projection: this.projection,
      compaction: this.compaction,
      emit,
      emitProviderCheckpoint: (
        turnId,
        providerTurnId,
        providerCheckpointMessageId
      ) =>
        this.emitProviderCheckpoint(
          turnId,
          providerTurnId,
          providerCheckpointMessageId
        ),
      ensureProviderTurnAcceptance: (phase) =>
        this.ensureProviderTurnAcceptance(phase),
      peekGuidanceInterrupt: () => this.pendingGuidanceInterrupt,
      clearGuidanceInterrupt: () => {
        this.pendingGuidanceInterrupt = false;
      },
      resolveGoalTranscriptPath: (sessionId, providerCwd) =>
        claudeGoalTranscriptPath({
          sessionId,
          cwd: providerCwd.trim() || this.cwd || process.cwd(),
          env: {
            ...process.env,
            ...claudeSettingsEnv(this.cwd || process.cwd()),
            ...this.env
          }
        })
    });
    this.claudeOptions = claudeOptions;
    this.queryFactory = queryFactory;
    this.resumeCursor = normalizeResumeCursor(
      resumeCursor,
      this.providerSessionId
    );
    this.lastAssistantUuid = stringValue(this.resumeCursor?.resumeSessionAt);
    this.turns.restoreTurnCount(numberValue(this.resumeCursor?.turnCount));
  }

  async start(): Promise<void> {
    this.diagnostics.logAuthRefresh("session_start.begin", {
      restore: this.restore,
      initialized: this.initialized,
      queryClosed: this.sessionClosed
    });
    if (this.restore) {
      await this.router.observeRootSession(this.providerSessionId, this.cwd);
    }
    await this.ensureQuery({ initialize: true });
    await this.runConfigurationTask(() =>
      this.configuration.applyPendingFlags()
    );
    emit({
      type: "session_started",
      payload: {
        providerSessionId: this.providerSessionId,
        ...this.sessionStatePayload(),
        resumeCursor: this.currentResumeCursor()
      }
    });
    // Restore must not await getContextUsage before session_started: the SDK
    // call can hang for minutes with no timeout, and Host Resume/Send blocks
    // on this start handshake. Refresh usage in the background like turn
    // completion already does.
    if (this.restore) {
      void this.compaction.emitContextUsageSnapshot("");
    }
    const generation = this.queryGeneration;
    if (generation && this.isQueryGenerationActive(generation)) {
      // The SDK publishes its per-user resolved model in system/init before it
      // needs the first prompt. Keep the iterator alive from session start so
      // Default never has to be inferred from the advertised catalog label.
      this.consume(generation);
    }
    this.diagnostics.logAuthRefresh("session_start.succeeded", {
      restore: this.restore,
      initialized: this.initialized,
      queryClosed: this.sessionClosed
    });
  }

  exec(
    turnId: string,
    prompt: string,
    content?: unknown,
    turnOrigin?: string,
    goal?: GoalCommandDispatch,
    hostContext = "",
    promptCorrelationId = ""
  ): void {
    if (this.driver) {
      this.driver.exec(turnId, prompt, promptCorrelationId);
      return;
    }
    if (this.sessionClosed) {
      emit({
        type: "turn_failed",
        payload: {
          turnId,
          error: "Claude SDK query is closed"
        }
      });
      return;
    }
    if (goal?.operationId && goal.revision > 0) {
      this.goalExecQueue.accept({
        turnId,
        promptCorrelationId,
        prompt,
        content,
        turnOrigin,
        hostContext,
        goal
      });
      return;
    }
    this.dispatchExec(
      turnId,
      promptCorrelationId,
      prompt,
      content,
      turnOrigin,
      undefined,
      hostContext
    );
  }

  private dispatchExec(
    turnId: string,
    promptCorrelationId: string | undefined,
    prompt: string,
    content?: unknown,
    turnOrigin?: string,
    goal?: GoalCommandDispatch,
    hostContext = ""
  ): void {
    this.turns.closeSyntheticBeforeUserTurn();
    const turn: RuntimeTurn = {
      turnId,
      promptUuid: promptCorrelationId?.trim() || crypto.randomUUID(),
      ...(turnOrigin ? { origin: turnOrigin } : {}),
      ...(goal
        ? {
            goalOperationId: goal.operationId,
            goalRevision: goal.revision,
            goalRepairEpoch: goal.repairEpoch ?? 0,
            goalAction: goal.action
          }
        : {}),
      settled: false
    };
    this.providerTurnAcceptance.markQueued(turnId);
    // Continue/follow-up after a settled turn must not reuse a quiet Claude
    // query that accepted the next prompt but emitted no further SDK messages.
    // Retire the idle generation here (before enqueue) so ensureQuery resumes,
    // while still leaving the previous generation alive long enough for late
    // post-result traffic such as compact_boundary.
    this.retireIdleQueryBeforeNextTurn();
    const executionEpoch = this.executionEpoch;
    this.turns.enqueue(turn);
    this.compaction.selectCommand(turnId, isCompactCommandPrompt(prompt));
    void this.ensureQuery()
      .then(() =>
        this.runConfigurationTask(() => this.configuration.applyPendingFlags())
      )
      .then(() => {
        const generation = this.queryGeneration;
        if (
          !generation ||
          !this.isQueryGenerationActive(generation) ||
          executionEpoch !== this.executionEpoch ||
          turn.canceling ||
          turn.settled
        ) {
          return;
        }
        generation.registerTurn(turn.turnId);
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
        let outboundContent = sdkContent;
        if (hostContext.trim()) {
          const hostContextBlock = {
            type: "text" as const,
            text: hostContext.trim()
          };
          if (Array.isArray(sdkContent)) {
            sdkContent.unshift(hostContextBlock);
          } else {
            outboundContent = [
              hostContextBlock,
              { type: "text" as const, text: sdkContent }
            ];
          }
        }
        generation.expectPromptEcho(turn.promptUuid);
        this.turns.expectProviderTurnIdentity(turn.turnId);
        this.providerTurnAcceptance.markDispatched(turn.turnId);
        if (goal) {
          this.router.trackGoalCommand(goal.action, prompt);
        }
        generation.promptQueue.push({
          uuid: turn.promptUuid,
          type: "user",
          session_id: this.providerSessionId,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: outboundContent
          }
        } as SDKUserMessage);
        this.diagnostics.scheduleProviderTurnIdentityWarning(
          turn,
          generation.id
        );
        this.consume(generation);
      })
      .catch((error) => {
        if (executionEpoch !== this.executionEpoch || turn.settled) {
          return;
        }
        this.diagnostics.logAuthRefresh("exec.ensure_query_failed", {
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

  async guide(prompt: string, content?: unknown): Promise<void> {
    if (this.driver) {
      this.driver.guide(prompt);
      return;
    }
    if (this.sessionClosed) {
      throw new Error("Claude SDK query is closed");
    }
    const executionEpoch = this.executionEpoch;
    try {
      const generation = this.queryGeneration;
      if (
        !generation ||
        !this.isQueryGenerationActive(generation) ||
        executionEpoch !== this.executionEpoch
      ) {
        throw new Error("Claude SDK query changed before guidance preemption");
      }
      const turnId = this.turns.activeId.trim();
      if (!turnId) {
        throw new Error("Claude SDK guidance requires an active turn");
      }
      const interrupt = generation.query?.interrupt;
      if (typeof interrupt !== "function") {
        throw new Error(
          "Claude SDK query does not support guidance preemption"
        );
      }
      // Preempt in-flight tool work before enqueueing guidance. Without
      // interrupt, Bash/etc. finish first and the model often ignores the
      // inserted prompt while the old response remains active.
      // Mark the interrupt so the following error_during_execution result
      // keeps this turn alive for the guided prompt (see messageRouter).
      this.pendingGuidanceInterrupt = true;
      try {
        // Calling the SDK method happens before this async function first
        // yields. Guidance must not wait behind query setup or configuration
        // work while the current provider response keeps running.
        await interrupt.call(generation.query);
      } catch (error) {
        this.pendingGuidanceInterrupt = false;
        this.diagnostics.logAuthRefresh("guide.interrupt_failed", {
          error: errorPayload(error)
        });
        throw new Error(
          `Claude SDK guidance preemption failed: ${errorMessage(error)}`,
          { cause: error }
        );
      }
      if (
        !this.isQueryGenerationActive(generation) ||
        executionEpoch !== this.executionEpoch
      ) {
        this.pendingGuidanceInterrupt = false;
        throw new Error("Claude SDK query changed during guidance preemption");
      }
      // Publish the response boundary as soon as the SDK confirms the
      // interrupt, before the guided prompt is enqueued. The later
      // error_during_execution result is only a provider bookkeeping event.
      emit({
        type: "guidance_interrupted",
        payload: { turnId }
      });
      const sdkContent = sdkContentFromPromptBlocks(
        content,
        prompt
      ) as unknown as SDKUserMessage["message"]["content"];
      try {
        generation.promptQueue.push({
          uuid: crypto.randomUUID(),
          type: "user",
          session_id: this.providerSessionId,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: sdkContent
          }
        } as SDKUserMessage);
        this.consume(generation);
      } catch (error) {
        this.pendingGuidanceInterrupt = false;
        throw error;
      }
    } catch (error) {
      this.diagnostics.logAuthRefresh("guide.failed", {
        error: errorPayload(error)
      });
      throw error;
    }
  }

  async cancel(
    expectedTurnId = "",
    shutdownOptions: QueryShutdownOptions = {}
  ): Promise<SessionCancelResult> {
    expectedTurnId =
      expectedTurnId.trim() || this.turns.activeTurn?.turnId.trim() || "";
    if (this.sessionClosed) {
      return cancelResult(false, "absent", expectedTurnId);
    }
    if (!expectedTurnId) {
      return cancelResult(false, "absent", "");
    }

    const pendingGoal = this.goalExecQueue.cancelExact(expectedTurnId);
    if (pendingGoal) {
      this.emitPendingGoalCanceled(pendingGoal);
      return cancelResult(
        true,
        "pre_accept",
        expectedTurnId,
        "",
        "pending_goal"
      );
    }

    const generation = this.queryGeneration;
    const preparation = this.turns.prepareExactCancellation(expectedTurnId);
    // The canonical root Turn and a provider-native synthetic continuation
    // have different Turn ids but can still be live members of one Query
    // generation. The synthetic id may be the current active Turn, so an
    // exact root cancellation can look absent/mismatched to TurnLifecycle.
    // Generation ownership is the narrow proof that permits retiring that
    // Query; it never retargets a stop request to an unrelated newer Query.
    const ownsExpectedTurn = generation?.ownsTurn(expectedTurnId) === true;
    const phase =
      this.providerTurnAcceptance.phase(expectedTurnId) ?? "unknown";
    const providerStateWasAccepted =
      preparation.providerTurnId.trim() !== "" ||
      this.acceptedProviderTurnIds.has(expectedTurnId) ||
      (phase !== "queued" &&
        phase !== "dispatched" &&
        phase !== "provider_observed" &&
        phase !== "resolving_identity" &&
        phase !== "terminal" &&
        phase !== "unknown");
    if (preparation.disposition === "absent" && !ownsExpectedTurn) {
      if (providerStateWasAccepted) {
        return cancelResult(
          false,
          "provider_state_lost",
          expectedTurnId,
          preparation.providerTurnId,
          phase
        );
      }
      return cancelResult(false, "absent", expectedTurnId);
    }
    if (preparation.disposition === "mismatch" && !ownsExpectedTurn) {
      return cancelResult(false, "mismatch", expectedTurnId);
    }
    if (preparation.disposition === "unresolved") {
      throw new Error(
        `Claude SDK exact cancellation remains unresolved for turn ${expectedTurnId}`
      );
    }

    if (
      preparation.differentActiveTurn &&
      phase !== "queued" &&
      !ownsExpectedTurn
    ) {
      this.turns.releaseExactCancellation(expectedTurnId);
      return cancelResult(false, "mismatch", expectedTurnId, "", phase);
    }
    if (preparation.disposition === "queued" && phase === "queued") {
      if (!this.turns.commitExactCancellation(expectedTurnId)) {
        throw new Error(
          `Claude SDK lost exact cancellation target ${expectedTurnId}`
        );
      }
      this.turns.clearCancelled();
      return cancelResult(true, "pre_accept", expectedTurnId, "", phase);
    }

    if (!generation) {
      if (providerStateWasAccepted) {
        this.turns.releaseExactCancellation(expectedTurnId);
        this.turns.clearCancelled();
        return cancelResult(
          false,
          "provider_state_lost",
          expectedTurnId,
          preparation.providerTurnId,
          phase
        );
      }
      this.turns.discardExactAbsent(expectedTurnId);
      this.turns.clearCancelled();
      return cancelResult(false, "absent", expectedTurnId, "", phase);
    }

    // One SDK Query owns every Turn already handed to its prompt queue. Native
    // interrupt retires that entire generation, so fence and settle every such
    // Turn after the same shutdown ACK instead of stranding collateral Goal
    // commands whose prompts can no longer run.
    const generationTurnIds = this.turns.prepareGenerationCancellation();
    this.activities.cancel();
    this.executionEpoch += 1;
    this.providerTurnAcceptance.cancel();
    this.canceledQueryTailPending = true;
    this.interactions.rejectAll(new Error("Tool use aborted"));
    this.queryGeneration = undefined;
    await generation.shutdown(true, shutdownOptions);
    for (const turnId of generationTurnIds) {
      if (!this.turns.commitExactCancellation(turnId)) {
        throw new Error(`Claude SDK lost canceled Query turn ${turnId}`);
      }
    }
    this.turns.clearCancelled();
    return cancelResult(
      true,
      preparation.providerTurnId ? "provider_active" : "pre_accept",
      expectedTurnId,
      preparation.providerTurnId,
      phase
    );
  }

  private emitPendingGoalCanceled(input: GoalExecInput): void {
    emit({
      type: "goal_command_canceled",
      payload: {
        turnId: input.turnId,
        operationId: input.goal.operationId,
        revision: input.goal.revision,
        repairEpoch: input.goal.repairEpoch ?? 0,
        action: input.goal.action,
        reason: "cancel_requested"
      }
    });
  }

  async stopTask(taskId: string, parentToolUseId = ""): Promise<boolean> {
    if (this.sessionClosed) {
      return false;
    }
    const resolvedTaskId = this.activities.resolveDelegatedTaskIdForStop(
      taskId,
      parentToolUseId
    );
    const stopTask = this.query?.stopTask;
    if (!resolvedTaskId || !stopTask) {
      return false;
    }
    // The stopped task_notification that follows settles the task's activity
    // state; no local bookkeeping happens here so a failed stop stays running.
    await stopTask.call(this.query, resolvedTaskId);
    return true;
  }

  async close(): Promise<void> {
    if (this.sessionClosed) {
      return;
    }
    this.sessionClosed = true;
    this.executionEpoch += 1;
    this.providerTurnAcceptance.cancel();
    this.interactions.rejectAll(new Error("Tool use aborted"));
    this.activities.close();
    await this.router.close();
    this.turns.close();
    const generation = this.queryGeneration;
    this.queryGeneration = undefined;
    await generation?.shutdown(false);
  }

  submitInteractive(
    turnId: string,
    requestId: string,
    action: string,
    optionId: string,
    payload: Record<string, unknown>
  ) {
    return this.interactions.submit(
      turnId,
      requestId,
      action,
      optionId,
      payload
    );
  }

  interactiveDisposition(
    turnId: string,
    requestId: string,
    action: string,
    optionId: string,
    payload: Record<string, unknown>
  ) {
    return this.interactions.disposition(turnId, requestId, {
      action,
      optionId,
      payload
    });
  }

  async applySettings(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.runConfigurationTask(async () => {
        // Live applyFlagSettings on a quiet post-turn Claude query can hang
        // indefinitely. Because the sidecar stdin loop awaits each request,
        // that hang also blocks every later exec/settings round-trip and the
        // daemon UpdateSettings HTTP call times out at ~30s. Retire the idle
        // generation first so effort/speed stay as pending flags and are baked
        // into the next turn's ensureQuery create-time settings (not a live
        // applyFlagSettings on the resumed quiet query, which still delayed
        // provider identity / delivery confirmation by ~90s).
        this.retireIdleQueryBeforeNextTurn();
        await this.configuration.apply(payload);
        this.emitSessionState();
      });
    } catch (error) {
      // A failed/canceled live settings write must not leave the next turn on a
      // half-mutated idle query (submitted with no SDK traffic for minutes).
      this.retireIdleQueryBeforeNextTurn();
      throw error;
    }
  }

  private runConfigurationTask<T>(task: () => Promise<T>): Promise<T> {
    const run = this.configurationGate.then(task, task);
    this.configurationGate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private consume(generation: QueryGeneration): void {
    if (!generation.query || generation.consumption) {
      return;
    }
    generation.consumption = (async () => {
      const iterator = generation.query?.[Symbol.asyncIterator]();
      try {
        if (!iterator) {
          return;
        }
        for (;;) {
          let next: IteratorResult<SDKMessage>;
          try {
            next = await this.nextQueryMessage(iterator, generation);
          } catch (error) {
            if (isAbortError(error)) {
              break;
            }
            throw error;
          }
          if (next.done) {
            break;
          }
          if (!this.isQueryGenerationActive(generation)) {
            break;
          }
          const message = next.value;
          const shouldRoute = generation.shouldRouteMessage(message);
          if (!shouldRoute) {
            continue;
          }
          await this.router.handle(message);
        }
      } catch (error) {
        if (isAbortError(error) && !this.isQueryGenerationActive(generation)) {
          return;
        }
        this.diagnostics.logQueryFailure(generation.id, error);
        this.diagnostics.logAuthRefresh("query_consume.failed", {
          activeTurnId: this.turns.activeId,
          queuedTurnIds: this.turns.queue
            .filter((turn) => !turn.settled)
            .map((turn) => turn.turnId),
          error: errorPayload(error)
        });
        this.turns.failLiveTurns(errorMessage(error));
      } finally {
        if (this.queryGeneration === generation) {
          this.diagnostics.logQueryEnd(generation.id);
          this.queryGeneration = undefined;
          generation.revoke();
          generation.closeQuery();
          // Do not mark the Session closed here. A natural query iterator end
          // (or a retired idle generation) must remain resumable for the next
          // user turn; only SessionRuntime.close() makes the Session terminal.
          if (this.turns.activeTurn) {
            this.turns.settleActive(
              this.turns.cancelled ? "turn_canceled" : "turn_failed"
            );
          }
          this.turns.failQueuedTurns("Claude SDK session ended");
          this.turns.clearCancelled();
        }
      }
    })();
  }

  private nextQueryMessage(
    iterator: AsyncIterator<SDKMessage>,
    generation: QueryGeneration
  ): Promise<IteratorResult<SDKMessage>> {
    const signal = generation.cancelController.signal;
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

  private async ensureQuery(
    startOptions: { initialize?: boolean } = {}
  ): Promise<void> {
    if (this.queryGeneration || this.driver) {
      return;
    }
    if (this.sessionClosed) {
      throw new Error("Claude SDK session is closed");
    }
    const executionEpoch = this.executionEpoch;
    const queryFactory =
      this.queryFactory ??
      (await import("@anthropic-ai/claude-agent-sdk")).query;
    if (executionEpoch !== this.executionEpoch || this.sessionClosed) {
      throw new Error("Claude SDK query generation was retired");
    }
    const generation = new QueryGeneration(
      ++this.nextQueryGenerationId,
      this.canceledQueryTailPending
    );
    this.activities.resetBackgroundTaskLevel();
    this.queryGeneration = generation;
    const permissionMode = effectivePermissionMode(this.configuration.settings);
    const allowBypassPermissions = canBypassPermissions();
    const querySettings = querySettingsFromSessionSettings(
      this.configuration.settings
    );
    // Pending effort/speed from apply_settings after idle-retire must land in
    // create-time settings above. Absorb them here so the post-ensureQuery
    // applyPendingFlags path does not call applyFlagSettings on this quiet
    // resumed generation (that delayed turn-2 identity past the 30s host
    // delivery timeout in C05).
    this.configuration.absorbPendingFlagsIntoQueryCreate();
    // One settings snapshot feeds both the executable resolution and the SDK
    // env, so the two can never disagree (and the settings hierarchy is read
    // once per query creation).
    const settingsEnv = claudeSettingsEnv(this.cwd || process.cwd());
    // Same merge (and precedence) as queryOptions.env below, so an override
    // set in Claude settings files is honored exactly like one from the
    // process or session environment.
    const claudeExecutablePath = resolveClaudeCodeExecutablePath({
      ...process.env,
      ...settingsEnv,
      ...this.env
    });
    const queryOptions: ClaudeQueryOptions = {
      cwd: this.cwd || process.cwd(),
      env: {
        ...process.env,
        ...settingsEnv,
        ...this.env,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1"
      },
      ...(claudeExecutablePath
        ? { pathToClaudeCodeExecutable: claudeExecutablePath }
        : {}),
      includePartialMessages: true,
      includeHookEvents: true,
      canUseTool: (toolName, toolInput, callbackOptions) =>
        this.handleToolPermission(
          generation,
          String(toolName),
          recordValue(toolInput) ?? {},
          callbackOptions as ToolPermissionOptions
        ),
      ...(this.resumeQueries
        ? { resume: this.providerSessionId }
        : { sessionId: this.providerSessionId }),
      ...(modelOptionValue(this.configuration.settings.model)
        ? { model: modelOptionValue(this.configuration.settings.model) }
        : {}),
      ...(permissionMode ? { permissionMode } : {}),
      allowDangerouslySkipPermissions: allowBypassPermissions,
      ...(Object.keys(querySettings).length > 0
        ? { settings: querySettings }
        : {}),
      ...claudeQueryOptionOverrides(this.claudeOptions),
      hooks: queryGenerationHooks({
        generation,
        isActive: () => this.isQueryGenerationActive(generation),
        onSessionStart: async (input) => {
          await this.router.observeSessionStartHook(input);
          return { continue: true };
        },
        onPostToolUse: (input, toolUseID) =>
          this.activities.handlePostToolUseHook(input, toolUseID),
        onTaskLifecycle: (input) =>
          this.activities.handleTaskLifecycleHook(input)
      })
    } as ClaudeQueryOptions;
    this.diagnostics.logAuthRefresh("query_create.begin", {
      initialize: startOptions.initialize === true,
      restore: this.resumeQueries,
      permissionMode,
      hasExecutablePathOverride: Boolean(claudeExecutablePath),
      hasModel: Boolean(modelOptionValue(this.configuration.settings.model)),
      hasResumeCursor: Boolean(this.resumeCursor),
      querySettingsKeys: Object.keys(querySettings),
      claudeOptionKeys: Object.keys(
        claudeQueryOptionOverrides(this.claudeOptions)
      )
    });
    try {
      generation.query = queryFactory({
        prompt: generation.promptQueue.iterate(),
        options: queryOptions
      }) as ClaudeQueryRuntime;
      this.diagnostics.logAuthRefresh("query_create.succeeded", {
        initialize: startOptions.initialize === true,
        restore: this.resumeQueries,
        hasInitializationResult:
          typeof generation.query.initializationResult === "function"
      });
      if (startOptions.initialize || this.resumeQueries) {
        try {
          this.diagnostics.logAuthRefresh("query_initialization.begin", {
            restore: this.resumeQueries
          });
          const initializationResult =
            await generation.query.initializationResult?.();
          if (
            executionEpoch !== this.executionEpoch ||
            !this.isQueryGenerationActive(generation)
          ) {
            throw new Error("Claude SDK query generation was retired");
          }
          this.configuration.applyInitializationResult(initializationResult);
          this.initialized = true;
          this.resumeQueries = true;
          this.diagnostics.logAuthRefresh("query_initialization.succeeded", {
            restore: this.resumeQueries,
            resultKeys: Object.keys(recordValue(initializationResult) ?? {})
          });
        } catch (error) {
          this.diagnostics.logAuthRefresh("query_initialization.failed", {
            restore: this.resumeQueries,
            error: errorPayload(error)
          });
          this.initialized = false;
          throw error;
        }
      } else {
        this.resumeQueries = true;
      }
      this.canceledQueryTailPending = false;
    } catch (error) {
      if (this.queryGeneration === generation) {
        this.queryGeneration = undefined;
      }
      generation.revoke();
      generation.closeQuery();
      throw error;
    }
  }

  private handleToolPermission(
    generation: QueryGeneration,
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    if (!this.isQueryGenerationActive(generation)) {
      return Promise.resolve({
        behavior: "deny",
        message: "Tool use aborted"
      });
    }
    return this.interactions.handleToolPermission(
      toolName,
      toolInput,
      callbackOptions
    );
  }

  private ensureProviderTurnAcceptance(
    phase: Extract<
      ProviderTurnPhase,
      "streaming" | "waiting_approval" | "waiting_input" | "running_tool"
    >,
    signal?: AbortSignal
  ): Promise<void> {
    return this.providerTurnAcceptance.ensure(phase, signal);
  }

  private emitProviderCheckpoint(
    turnId: string,
    providerTurnId: string,
    providerCheckpointMessageId: string
  ): void {
    turnId = turnId.trim();
    providerTurnId = providerTurnId.trim();
    providerCheckpointMessageId = providerCheckpointMessageId.trim();
    if (!turnId || !providerTurnId || !providerCheckpointMessageId) {
      return;
    }
    const key = `${turnId}\u0000${providerTurnId}\u0000${providerCheckpointMessageId}`;
    if (this.emittedProviderCheckpoints.has(key)) {
      return;
    }
    this.emittedProviderCheckpoints.add(key);
    while (this.emittedProviderCheckpoints.size > 128) {
      const oldest = this.emittedProviderCheckpoints.values().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.emittedProviderCheckpoints.delete(oldest);
    }
    emit({
      type: "provider_turn_checkpoint",
      payload: { turnId, providerTurnId, providerCheckpointMessageId }
    });
  }

  private isQueryGenerationActive(generation: QueryGeneration): boolean {
    return (
      !this.sessionClosed &&
      !generation.revoked &&
      this.queryGeneration === generation
    );
  }

  private retireIdleQueryBeforeNextTurn(): void {
    if (!this.queryGeneration) {
      return;
    }
    // The session.start() initialization query must stay until the first turn
    // uses it. Only retire after at least one root turn has already settled.
    if (this.turns.turnCount === 0) {
      return;
    }
    if (this.turns.activeTurn && !this.turns.activeTurn.settled) {
      return;
    }
    if (this.turns.queue.some((turn) => !turn.settled)) {
      return;
    }
    if (this.activities.hasPendingBackgroundContinuation()) {
      return;
    }
    this.executionEpoch += 1;
    this.resumeQueries = true;
    QueryGeneration.retire(this.queryGeneration, () => {
      this.queryGeneration = undefined;
    });
  }

  private resetTurnScratch(): void {
    this.assistantStream.reset();
    this.activities.resetTurnScratch();
  }

  private currentResumeCursor(): Record<string, unknown> {
    this.resumeCursor = {
      kind: "claude-agent-sdk",
      version: 1,
      resume: this.providerSessionId,
      ...(this.lastAssistantUuid
        ? { resumeSessionAt: this.lastAssistantUuid }
        : {}),
      turnCount: this.turns.turnCount
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
    return this.configuration.sessionStatePayload();
  }

  private async maybeEmitSessionTitleUpdated(
    shouldEmit: () => boolean = () => true
  ): Promise<void> {
    if (this.driver || !this.providerSessionId) {
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
      if (!shouldEmit() || !title || title === this.lastTitle) {
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
}
