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
import { QueryGeneration, type ClaudeQueryRuntime } from "./queryGeneration.ts";
import { queryGenerationHooks } from "./queryHooks.ts";
import {
  claudeAuthRefreshDiagnosticsEnabled,
  claudeCredentialSnapshot,
  debugClaudeAuthRefreshLog
} from "./authDiagnostics.ts";
import { errorMessage, errorPayload } from "./errors.ts";
import { AssistantStreamProjector } from "./assistantStream.ts";
import {
  InteractiveCoordinator,
  type ToolPermissionOptions
} from "./interactive.ts";
import { resolveInteractiveTurnId } from "./interactiveTurnResolver.ts";
import { GoalExecQueue, type GoalCommandDispatch } from "./goalExecQueue.ts";
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
import { emit } from "./eventSink.ts";
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
  private readonly claudeOptions: SidecarClaudeOptions;
  private readonly queryFactory?: ClaudeQueryFactory;
  private readonly interactions: InteractiveCoordinator;
  private readonly router: SDKMessageRouter;
  private readonly driver?: SidecarTestDriver;
  private readonly goalExecQueue: GoalExecQueue;

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
    continuationStartTimeoutMs = 30_000
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
      onSettled: () => this.emitSessionState(),
      continuationStartTimeoutMs,
      onContinuationStartTimeout: () => {
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
      emit
    });
    this.driver = testDriver
      ? new SidecarTestDriver(this.turns, this.interactions)
      : undefined;
    this.goalExecQueue = new GoalExecQueue((input) =>
      this.dispatchExec(
        input.turnId,
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
      onSessionState: () => this.emitSessionState(),
      onMaybeTitle: (shouldEmit) =>
        this.maybeEmitSessionTitleUpdated(shouldEmit),
      turns: this.turns,
      assistant: this.assistantStream,
      activities: this.activities,
      projection: this.projection,
      compaction: this.compaction,
      emit
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
    this.logAuthRefresh("session_start.begin", {
      restore: this.restore,
      initialized: this.initialized,
      queryClosed: this.sessionClosed
    });
    await this.ensureQuery({ initialize: true });
    await this.configuration.applyPendingFlags();
    if (this.restore) {
      await this.compaction.emitContextUsageSnapshot("");
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
      queryClosed: this.sessionClosed
    });
  }

  exec(
    turnId: string,
    prompt: string,
    content?: unknown,
    turnOrigin?: string,
    goal?: GoalCommandDispatch,
    hostContext = ""
  ): void {
    if (this.driver) {
      this.driver.exec(turnId, prompt);
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
      prompt,
      content,
      turnOrigin,
      undefined,
      hostContext
    );
  }

  private dispatchExec(
    turnId: string,
    prompt: string,
    content?: unknown,
    turnOrigin?: string,
    goal?: GoalCommandDispatch,
    hostContext = ""
  ): void {
    this.turns.closeSyntheticBeforeUserTurn();
    const turn: RuntimeTurn = {
      turnId,
      promptUuid: crypto.randomUUID(),
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
    const executionEpoch = this.executionEpoch;
    this.turns.enqueue(turn);
    this.compaction.selectCommand(turnId, isCompactCommandPrompt(prompt));
    void this.ensureQuery()
      .then(() => this.configuration.applyPendingFlags())
      .then(() => {
        const generation = this.queryGeneration;
        if (
          !generation ||
          !this.isQueryGenerationActive(generation) ||
          executionEpoch !== this.executionEpoch ||
          turn.settled
        ) {
          return;
        }
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
        let outboundContent = sdkContent;
        if (hostContext.trim()) {
          const hostContextBlock = { type: "text" as const, text: hostContext.trim() };
          if (Array.isArray(sdkContent)) {
            sdkContent.unshift(hostContextBlock);
          } else {
            outboundContent = [hostContextBlock, { type: "text" as const, text: sdkContent }];
          }
        }
        generation.expectPromptEcho(turn.promptUuid);
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
        this.consume(generation);
      })
      .catch((error) => {
        if (executionEpoch !== this.executionEpoch || turn.settled) {
          return;
        }
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

  guide(prompt: string, content?: unknown): void {
    if (this.driver) {
      this.driver.guide(prompt);
      return;
    }
    if (this.sessionClosed) {
      emit({
        type: "error",
        payload: {
          error: "Claude SDK query is closed"
        }
      });
      return;
    }
    const executionEpoch = this.executionEpoch;
    void this.ensureQuery()
      .then(() => this.configuration.applyPendingFlags())
      .then(() => {
        const generation = this.queryGeneration;
        if (
          !generation ||
          !this.isQueryGenerationActive(generation) ||
          executionEpoch !== this.executionEpoch
        ) {
          return;
        }
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
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
      })
      .catch((error) => {
        if (executionEpoch !== this.executionEpoch) {
          return;
        }
        this.logAuthRefresh("guide.ensure_query_failed", {
          error: errorPayload(error)
        });
        emit({
          type: "error",
          payload: {
            error: errorMessage(error)
          }
        });
      });
  }

  async cancel(expectedTurnId = ""): Promise<boolean> {
    if (this.sessionClosed) {
      return false;
    }
    let hasActiveTurn: boolean;
    if (expectedTurnId) {
      hasActiveTurn = this.turns.cancelActiveExact(expectedTurnId);
      if (!hasActiveTurn) {
        return false;
      }
    } else {
      hasActiveTurn = this.turns.cancelQueued();
    }
    this.executionEpoch += 1;
    this.canceledQueryTailPending = true;
    this.interactions.rejectAll(new Error("Tool use aborted"));
    const generation = this.queryGeneration;
    this.queryGeneration = undefined;
    try {
      await generation?.shutdown(true);
    } finally {
      if (hasActiveTurn) {
        this.turns.settleActive("turn_canceled");
      }
      this.turns.clearCancelled();
    }
    return hasActiveTurn;
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
    this.interactions.rejectAll(new Error("Tool use aborted"));
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
    await this.configuration.apply(payload);
    this.emitSessionState();
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
          if (!generation.shouldRouteMessage(message)) {
            continue;
          }
          await this.router.handle(message);
        }
      } catch (error) {
        this.logAuthRefresh("query_consume.failed", {
          activeTurnId: this.turns.activeId,
          queuedTurnIds: this.turns.queue
            .filter((turn) => !turn.settled)
            .map((turn) => turn.turnId),
          error: errorPayload(error)
        });
        this.turns.failLiveTurns(errorMessage(error));
      } finally {
        if (this.queryGeneration === generation) {
          this.queryGeneration = undefined;
          generation.revoke();
          generation.closeQuery();
          this.sessionClosed = true;
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
    this.queryGeneration = generation;
    const permissionMode = effectivePermissionMode(this.configuration.settings);
    const allowBypassPermissions = canBypassPermissions();
    const querySettings = querySettingsFromSessionSettings(
      this.configuration.settings
    );
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
        onPostToolUse: (input, toolUseID) =>
          this.activities.handlePostToolUseHook(input, toolUseID),
        onTaskLifecycle: (input) =>
          this.activities.handleTaskLifecycleHook(input)
      })
    } as ClaudeQueryOptions;
    this.logAuthRefresh("query_create.begin", {
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
      this.logAuthRefresh("query_create.succeeded", {
        initialize: startOptions.initialize === true,
        restore: this.resumeQueries,
        hasInitializationResult:
          typeof generation.query.initializationResult === "function"
      });
      if (startOptions.initialize || this.resumeQueries) {
        try {
          this.logAuthRefresh("query_initialization.begin", {
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
          this.logAuthRefresh("query_initialization.succeeded", {
            restore: this.resumeQueries,
            resultKeys: Object.keys(recordValue(initializationResult) ?? {})
          });
        } catch (error) {
          this.logAuthRefresh("query_initialization.failed", {
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

  private isQueryGenerationActive(generation: QueryGeneration): boolean {
    return (
      !this.sessionClosed &&
      !generation.revoked &&
      this.queryGeneration === generation
    );
  }

  private logAuthRefresh(
    stage: string,
    payload: Record<string, unknown>
  ): void {
    if (!claudeAuthRefreshDiagnosticsEnabled()) {
      return;
    }
    debugClaudeAuthRefreshLog(stage, {
      providerSessionId: this.providerSessionId,
      cwd: this.cwd,
      credentials: claudeCredentialSnapshot(),
      ...payload
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
