import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
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
import { AsyncPromptQueue } from "./promptQueue.ts";
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
  type PendingFlagSettings,
  type SidecarSessionSettings
} from "./sessionSettings.ts";

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

type ClaudeHookCallback = (
  input: unknown,
  toolUseID?: string
) => Promise<{ continue: boolean }>;

const DEFAULT_FORCE_CANCEL_GRACE_MS = 30_000;
export class SessionRuntime {
  readonly promptQueue = new AsyncPromptQueue();
  query: ClaudeQueryRuntime | undefined;
  providerSessionId: string;
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly restore: boolean;
  private readonly testDriver: boolean;
  private readonly turns: TurnLifecycle;
  private readonly assistantStream: AssistantStreamProjector;
  private readonly activities: ToolActivityProjector;
  private readonly compaction: CompactionTracker;
  private readonly projection: MessageProjection;
  private consuming = false;
  private initialized = false;
  private queryClosed = false;
  private cancelController = new AbortController();
  private lastTitle = "";
  private lastAssistantUuid = "";
  private resumeCursor: Record<string, unknown> | undefined;
  private readonly configuration: SessionConfiguration;
  private readonly claudeOptions: SidecarClaudeOptions;
  private readonly queryFactory?: ClaudeQueryFactory;
  private readonly interactions: InteractiveCoordinator;
  private readonly router: SDKMessageRouter;
  private readonly driver?: SidecarTestDriver;

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
    this.turns = new TurnLifecycle({
      emit,
      onActivate: () => this.resetTurnScratch(),
      onSettled: () => this.emitSessionState()
    });
    this.assistantStream = new AssistantStreamProjector(
      () => this.turns.activeId,
      emit
    );
    this.activities = new ToolActivityProjector(
      () => this.turns.activeId,
      emit
    );
    this.compaction = new CompactionTracker({
      activeTurnId: () => this.turns.activeId,
      ensureActive: (messageType) => {
        this.turns.ensureActive(messageType);
      },
      clearPendingOrphans: () => this.turns.clearPendingOrphans(),
      getQuery: () => this.query,
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
      resolveTurnId: (options) => this.resolveInteractiveTurnId(options),
      activateSyntheticTurn: () => this.turns.activateSynthetic().turnId,
      emit
    });
    this.driver = testDriver
      ? new SidecarTestDriver(this.turns, this.interactions)
      : undefined;
    this.router = new SDKMessageRouter({
      getProviderSessionId: () => this.providerSessionId,
      setProviderSessionId: (value) => {
        this.providerSessionId = value;
      },
      onAssistantUuid: (value) => {
        this.lastAssistantUuid = value;
      },
      onSessionState: () => this.emitSessionState(),
      onMaybeTitle: () => this.maybeEmitSessionTitleUpdated(),
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
      queryClosed: this.queryClosed
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
      queryClosed: this.queryClosed
    });
  }

  exec(turnId: string, prompt: string, content?: unknown): void {
    if (this.driver) {
      this.driver.exec(turnId, prompt);
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
    this.turns.closeSyntheticBeforeUserTurn();
    const turn: RuntimeTurn = {
      turnId,
      promptUuid: crypto.randomUUID(),
      settled: false
    };
    this.compaction.selectCommand(turnId, isCompactCommandPrompt(prompt));
    void this.ensureQuery()
      .then(() => this.configuration.applyPendingFlags())
      .then(() => {
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
        this.turns.enqueue(turn);
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

  guide(prompt: string, content?: unknown): void {
    if (this.driver) {
      this.driver.guide(prompt);
      return;
    }
    if (this.queryClosed) {
      emit({
        type: "error",
        payload: {
          error: "Claude SDK query is closed"
        }
      });
      return;
    }
    void this.ensureQuery()
      .then(() => this.configuration.applyPendingFlags())
      .then(() => {
        const sdkContent = sdkContentFromPromptBlocks(
          content,
          prompt
        ) as unknown as SDKUserMessage["message"]["content"];
        this.promptQueue.push({
          uuid: crypto.randomUUID(),
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

  async cancel(): Promise<void> {
    if (this.queryClosed) {
      return;
    }
    const hasActiveTurn = this.turns.cancelQueued();
    this.interactions.rejectAll(new Error("Tool use aborted"));
    if (hasActiveTurn) {
      this.turns.scheduleForceCancel(() => {
        this.cancelController.abort();
      }, DEFAULT_FORCE_CANCEL_GRACE_MS);
    }
    await this.query?.interrupt?.();
  }

  async close(): Promise<void> {
    this.interactions.rejectAll(new Error("Tool use aborted"));
    this.turns.close();
    this.cancelController.abort();
    this.queryClosed = true;
    this.promptQueue.close();
    await Promise.resolve(this.query?.close?.());
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
              this.turns.settleActive("turn_canceled");
              this.turns.clearCancelled();
              this.cancelController = new AbortController();
              continue;
            }
            throw error;
          }
          if (next.done) {
            break;
          }
          const message = next.value;
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
        this.queryClosed = true;
        this.query = undefined;
        this.consuming = false;
        if (this.turns.activeTurn) {
          this.turns.settleActive(
            this.turns.cancelled ? "turn_canceled" : "turn_failed"
          );
        }
        this.turns.failQueuedTurns("Claude SDK session ended");
        this.turns.clearCancelled();
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

  private resolveInteractiveTurnId(
    callbackOptions: ToolPermissionOptions
  ): string {
    if (this.turns.activeId) {
      return this.turns.activeId;
    }
    const toolUseID = stringValue(callbackOptions.toolUseID);
    if (toolUseID) {
      const delegatedTurnId =
        this.activities.resolveInteractiveTurnId(toolUseID);
      if (delegatedTurnId) {
        return delegatedTurnId;
      }
    }
    for (let index = this.turns.queue.length - 1; index >= 0; index -= 1) {
      const turn = this.turns.queue[index];
      if (turn && !turn.settled && !turn.synthetic) {
        return turn.turnId;
      }
    }
    const runningDelegatedTurnId = this.activities.runningDelegatedTurnId();
    if (runningDelegatedTurnId) {
      return runningDelegatedTurnId;
    }
    for (let index = this.turns.queue.length - 1; index >= 0; index -= 1) {
      const turn = this.turns.queue[index];
      if (turn && !turn.settled) {
        return turn.turnId;
      }
    }
    // A settled delegated task is still a better anchor than an empty turn
    // id: turnless interactive events are rejected by the daemon activity
    // store, which silently drops the approval card and deadlocks the
    // requesting nested agent.
    return this.activities.latestDelegatedTurnId();
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
        this.interactions.handleToolPermission(
          String(toolName),
          recordValue(toolInput) ?? {},
          callbackOptions as ToolPermissionOptions
        ),
      ...(this.restore
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
      hooks: {
        PostToolUse: [
          {
            hooks: [
              ((input, toolUseID) =>
                this.activities.handlePostToolUseHook(
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
                this.activities.handleTaskLifecycleHook(
                  input
                )) satisfies ClaudeHookCallback
            ]
          }
        ],
        TaskCompleted: [
          {
            hooks: [
              ((input) =>
                this.activities.handleTaskLifecycleHook(
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
      hasExecutablePathOverride: Boolean(claudeExecutablePath),
      hasModel: Boolean(modelOptionValue(this.configuration.settings.model)),
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
        this.configuration.applyInitializationResult(initializationResult);
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
}
