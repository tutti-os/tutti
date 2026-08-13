import type { EngineDiagnosticSink } from "./diagnostics.ts";
import type { AgentActivityComposerOptions } from "../types.ts";
import { projectAgentActivitySession } from "./agentActivitySnapshot.projector.ts";
import { composerOptionsRequestSignature } from "./composerOptions.helpers.ts";
import type { ComposerOptionsEntry } from "./composerOptions.types.ts";
import { projectPublicAgentSessionEngineState } from "./engineState.publicProjection.ts";
import { createEngineEffectExecutor } from "./effectExecutor.ts";
import { createEngineExpiryClock } from "./expiryClock.ts";
import {
  intentForEngineIdentity,
  withEngineObservationTime
} from "./engineIntent.normalization.ts";
import {
  selectEngineActiveTurn,
  selectEngineInteractionResponse,
  selectEngineInteractionsForSession,
  selectEngineLatestTurn,
  selectEnginePendingInteractions,
  selectEngineSession,
  selectEngineSessionSettingsUpdate
} from "./sessionLifecycle.selectors.ts";
import {
  selectLatestStopTargetSubmitForSession,
  selectPendingSubmitsForSession
} from "./pendingIntents.selectors.ts";
import {
  selectEngineHasVisibleQueuedSubmit,
  selectEngineSubmitWouldBeVisibleInQueue
} from "./promptQueue.selectors.ts";
import {
  dispatchSessionMutationWithCancellation,
  type SessionMutationCancellation
} from "./sessionMutationDispatch.ts";
import { requestSessionActivation } from "./sessionActivation.operation.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import {
  isEngineInternalCommand,
  type AgentSessionEngine,
  type AgentSessionEngineIdentity,
  type AgentSessionEngineIntentObserver,
  type AgentSessionEngineListener,
  type AgentSessionActivationInput,
  type AgentSessionLoadComposerOptionsInput,
  type AgentSessionStopInput,
  type AgentSessionSubmitInteractionResponseInput,
  type AgentSessionSubmitPromptInput,
  type AgentSessionSubmitPromptResult,
  type AgentSessionUpdateSettingsInput,
  type EngineClock,
  type EngineDispatchOptions,
  type EngineIntent,
  type EngineScheduledTask,
  type EngineScheduler,
  type EngineTypedCommandPort
} from "./types.ts";
import type {
  AgentSessionControlGoalAdmission,
  AgentSessionControlGoalInput
} from "./sessionGoalControl.types.ts";
import type {
  RootAgentSessionEngineState,
  RootEngineIntent
} from "./rootReducer.types.ts";

// All engine state lives inside this closure: one instance per workspace + origin
// pair, injected explicitly by the host. The dispatch loop is serial — an
// intent dispatched while a drain is running is queued and reduced within the
// same drain — and subscribers are notified at most once per drain cycle.

/**
 * Frame window for coalescing high-frequency intents (streaming message
 * updates). Migrated from the desktop activity service's 33ms event batching;
 * the engine owns this timing once event wiring moves over in later slices.
 */
export const ENGINE_INTENT_BATCH_DELAY_MS = 33;
const SESSION_MUTATION_TIMEOUT_MS = 30_000;
const SESSION_GOAL_CONTROL_TIMEOUT_MS = 30_000;
const SESSION_SETTINGS_UPDATE_TIMEOUT_MS = 30_000;
const SESSION_STOP_TIMEOUT_MS = 30_000;
const INTERACTION_RESPONSE_TIMEOUT_MS = 30_000;
const SESSION_PROMPT_CONFIRMATION_TIMEOUT_MS = 120_000;

export interface CreateAgentSessionEngineInput {
  batchDelayMs?: number;
  clock: EngineClock;
  commandPort: EngineTypedCommandPort;
  diagnosticSink?: EngineDiagnosticSink;
  identity: AgentSessionEngineIdentity;
  intentObserver?: AgentSessionEngineIntentObserver;
  scheduler: EngineScheduler;
}

export function createAgentSessionEngine({
  batchDelayMs = ENGINE_INTENT_BATCH_DELAY_MS,
  clock,
  commandPort,
  diagnosticSink,
  identity,
  intentObserver,
  scheduler
}: CreateAgentSessionEngineInput): AgentSessionEngine {
  if (identity.workspaceId.trim().length === 0) {
    throw new Error("agent session engine requires a non-empty workspaceId");
  }
  if (identity.origin.trim().length === 0) {
    throw new Error("agent session engine requires a non-empty origin");
  }
  const engineIdentity: AgentSessionEngineIdentity = Object.freeze({
    origin: identity.origin,
    workspaceId: identity.workspaceId
  });

  let state: RootAgentSessionEngineState =
    createInitialAgentSessionEngineState();
  let publicSnapshot = projectPublicAgentSessionEngineState(state);
  const listeners = new Set<AgentSessionEngineListener>();
  const intentQueue: RootEngineIntent[] = [];
  const batchedIntents: EngineIntent[] = [];
  let batchFlushTask: EngineScheduledTask | null = null;
  let draining = false;
  let disposed = false;
  let composerOptionsCommandSequence = 1;
  let interactionResponseCommandSequence = 1;
  let sessionGoalControlCommandSequence = 1;
  let sessionMutationSequence = 1;
  let sessionSettingsUpdateSequence = 1;
  let sessionStopCommandSequence = 1;
  const pendingComposerOptionsDisposals = new Set<() => void>();

  const expiryClock = createEngineExpiryClock({
    clock,
    onExpired: (intent) => {
      dispatch(intent);
    },
    scheduler
  });

  const effectExecutor = createEngineEffectExecutor({
    clock,
    commandPort,
    onResult: (intent) => {
      dispatch(intent);
    },
    scheduler,
    ...(diagnosticSink === undefined ? {} : { diagnosticSink })
  });

  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener(publicSnapshot);
      } catch (error) {
        if (diagnosticSink) {
          diagnosticSink({ error, type: "listenerError" });
        } else {
          console.error(
            "[agent-session-engine-diagnostic]",
            JSON.stringify({
              event: "listener_error",
              error: error instanceof Error ? error.message : String(error),
              origin: engineIdentity.origin,
              workspaceId: engineIdentity.workspaceId
            })
          );
        }
      }
    }
  }

  function drainQueue(): void {
    if (draining || disposed) {
      return;
    }
    draining = true;
    const publicSnapshotBeforeDrain = publicSnapshot;
    try {
      for (
        let intent = intentQueue.shift();
        intent !== undefined;
        intent = intentQueue.shift()
      ) {
        const result = rootEngineReducer(state, intent);
        if (result.state !== state) {
          const previousRoot = state;
          state = result.state;
          publicSnapshot = projectPublicAgentSessionEngineState(
            state,
            publicSnapshot,
            previousRoot,
            intent
          );
        }
        if (result.followUpIntents?.length) {
          intentQueue.unshift(...result.followUpIntents);
        }
        for (const command of result.commands) {
          if (command.type === "engine/abortExternalCommand") {
            effectExecutor.abort(command.targetCommandId, command.reason);
          } else if (isEngineInternalCommand(command)) {
            expiryClock.apply(command);
          } else {
            effectExecutor.execute(command);
          }
        }
      }
    } finally {
      draining = false;
    }
    if (publicSnapshot !== publicSnapshotBeforeDrain) {
      notifyListeners();
    }
  }

  function flushBatchedIntents(): void {
    if (batchFlushTask !== null) {
      batchFlushTask.cancel();
      batchFlushTask = null;
    }
    if (batchedIntents.length === 0) {
      return;
    }
    intentQueue.push(...batchedIntents);
    batchedIntents.length = 0;
  }

  function dispatch(
    intent: EngineIntent,
    options?: EngineDispatchOptions
  ): void {
    if (disposed) {
      diagnosticSink?.({
        intentType: intent.type,
        type: "intentDroppedAfterDispose"
      });
      return;
    }
    const scopedIntent = intentForEngineIdentity(
      withEngineObservationTime(intent, clock),
      engineIdentity
    );
    if (!scopedIntent) {
      diagnosticSink?.({
        intentType: intent.type,
        type: "intentDroppedForIdentityMismatch"
      });
      return;
    }
    if (intentObserver) {
      try {
        intentObserver(scopedIntent);
      } catch (error) {
        diagnosticSink?.({
          error,
          intentType: scopedIntent.type,
          type: "intentObserverError"
        });
      }
    }
    if (options?.batch === true) {
      batchedIntents.push(scopedIntent);
      if (batchFlushTask === null) {
        batchFlushTask = scheduler.schedule(batchDelayMs, () => {
          batchFlushTask = null;
          flushBatchedIntents();
          drainQueue();
        });
      }
      return;
    }
    // Non-batched dispatch flushes the pending frame first so cross-intent
    // ordering is preserved (a terminal event never overtakes the streaming
    // updates that preceded it).
    flushBatchedIntents();
    intentQueue.push(scopedIntent);
    drainQueue();
  }

  function nextComposerOptionsCommandId(): string {
    const sequence = composerOptionsCommandSequence++;
    return `composer-options:${clock.nowUnixMs()}:${sequence}`;
  }

  function loadComposerOptions(
    input: AgentSessionLoadComposerOptionsInput
  ): Promise<AgentActivityComposerOptions> {
    const targetKey = input.targetKey.trim();
    const provider = input.provider.trim();
    if (!targetKey) {
      return Promise.reject(new Error("composer_options_target_key_required"));
    }
    if (!provider) {
      return Promise.reject(new Error("composer_options_provider_required"));
    }
    if (disposed) {
      return Promise.reject(new Error("agent_session_engine_disposed"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(composerOptionsAbortReason(input.signal));
    }

    const commandId = nextComposerOptionsCommandId();
    const signature = composerOptionsRequestSignature({
      cwd: input.cwd,
      provider,
      settings: input.settings
    });
    const initialEntry =
      publicSnapshot.composerOptions.entriesByTargetKey[targetKey];
    const joinedCommandId =
      !input.force &&
      initialEntry?.status === "loading" &&
      initialEntry.loadingSignature === signature
        ? initialEntry.inFlightCommandId
        : null;

    return new Promise((resolve, reject) => {
      let settled = false;
      let awaitedCommandId = joinedCommandId;
      let previousEntry: ComposerOptionsEntry | undefined = initialEntry;
      let unsubscribe = (): void => {};

      const cleanup = (): void => {
        unsubscribe();
        input.signal?.removeEventListener("abort", onAbort);
        pendingComposerOptionsDisposals.delete(onDispose);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = (
        options: AgentActivityComposerOptions | undefined
      ): void => {
        if (settled || !options) return;
        settled = true;
        cleanup();
        resolve(options);
      };
      const observe = (): void => {
        if (settled || !awaitedCommandId) return;
        const composerOptions = publicSnapshot.composerOptions;
        const entry = composerOptions.entriesByTargetKey[targetKey];
        if (entry?.inFlightCommandId === awaitedCommandId) {
          previousEntry = entry;
          return;
        }
        if (previousEntry?.inFlightCommandId !== awaitedCommandId) {
          rejectOnce(new Error("composer_options_load_superseded"));
          return;
        }
        if (entry?.status === "ready") {
          resolveOnce(composerOptions.optionsByTargetKey[targetKey]);
          return;
        }
        if (entry?.status === "error") {
          rejectOnce(new Error("composer_options_load_failed"));
          return;
        }
        rejectOnce(new Error("composer_options_load_superseded"));
      };
      const onAbort = (): void => {
        rejectOnce(composerOptionsAbortReason(input.signal));
      };
      const onDispose = (): void => {
        rejectOnce(new Error("agent_session_engine_disposed"));
      };

      unsubscribe = engine.subscribe(observe);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      pendingComposerOptionsDisposals.add(onDispose);
      engine.dispatch({
        commandId,
        cwd: input.cwd,
        force: input.force,
        provider,
        settings: input.settings,
        targetKey,
        type: "composerOptions/loadRequested",
        workspaceId: engineIdentity.workspaceId
      });

      const composerOptions = publicSnapshot.composerOptions;
      const entry = composerOptions.entriesByTargetKey[targetKey];
      if (entry?.status === "ready" && entry.settledSignature === signature) {
        resolveOnce(composerOptions.optionsByTargetKey[targetKey]);
        return;
      }
      awaitedCommandId =
        entry?.inFlightCommandId === commandId
          ? commandId
          : !input.force && entry?.loadingSignature === signature
            ? (entry.inFlightCommandId ?? null)
            : null;
      previousEntry = entry;
      if (!awaitedCommandId) {
        rejectOnce(new Error("composer_options_load_not_accepted"));
        return;
      }
      observe();
    });
  }

  function nextSessionMutationId(kind: "delete" | "pin" | "rename"): string {
    const sequence = sessionMutationSequence++;
    return `${kind}:${clock.nowUnixMs()}:${sequence}`;
  }

  function nextSessionSettingsUpdateCommandId(): string {
    const sequence = sessionSettingsUpdateSequence++;
    return `settings:${clock.nowUnixMs()}:${sequence}`;
  }

  function nextInteractionResponseCommandId(): string {
    const sequence = interactionResponseCommandSequence++;
    return `interaction:${clock.nowUnixMs()}:${sequence}`;
  }

  function nextSessionGoalControlCommandId(requestedAtUnixMs: number): string {
    const sequence = sessionGoalControlCommandSequence++;
    return `goal:${requestedAtUnixMs}:${sequence}`;
  }

  function controlGoal(
    input: AgentSessionControlGoalInput
  ): AgentSessionControlGoalAdmission {
    const agentSessionId = input.agentSessionId.trim();
    const requestedClientSubmitId = input.clientSubmitId.trim();
    const objective = input.objective?.trim() || undefined;
    if (
      !agentSessionId ||
      !requestedClientSubmitId ||
      (input.action === "set" && !objective)
    ) {
      return { accepted: false, clientSubmitId: requestedClientSubmitId };
    }
    const current = state.goalControl.operationsBySessionId[agentSessionId];
    const clientSubmitId =
      current?.status === "unknown" &&
      current.action === input.action &&
      (input.action !== "set" || current.objective === objective)
        ? current.clientSubmitId
        : requestedClientSubmitId;
    const requestedAtUnixMs = clock.nowUnixMs();
    const commandId = nextSessionGoalControlCommandId(requestedAtUnixMs);
    dispatch({
      action: input.action,
      agentSessionId,
      clientSubmitId,
      commandId,
      ...(objective ? { objective } : {}),
      requestedAtUnixMs,
      timeoutMs: SESSION_GOAL_CONTROL_TIMEOUT_MS,
      type: "goal/controlRequested",
      workspaceId: engineIdentity.workspaceId
    });
    const operation = state.goalControl.operationsBySessionId[agentSessionId];
    return {
      accepted:
        operation?.commandId === commandId && operation.status === "pending",
      clientSubmitId
    };
  }

  function stopSession(input: AgentSessionStopInput): void {
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) {
      return;
    }
    const activeTurn = selectEngineActiveTurn(publicSnapshot, agentSessionId);
    const requestedClientSubmitId = input.clientSubmitId?.trim() || null;
    const clientSubmitId =
      requestedClientSubmitId ??
      (!activeTurn
        ? selectLatestStopTargetSubmitForSession(publicSnapshot, agentSessionId)
            ?.clientSubmitId
        : undefined);
    const requestedAtUnixMs = clock.nowUnixMs();
    const sequence = sessionStopCommandSequence++;
    dispatch({
      agentSessionId,
      awaitingTurnExpiresAtUnixMs: requestedAtUnixMs + SESSION_STOP_TIMEOUT_MS,
      commandId: `stop:${requestedAtUnixMs}:${sequence}`,
      ...(clientSubmitId ? { clientSubmitId } : {}),
      timeoutMs: SESSION_STOP_TIMEOUT_MS,
      type: "session/stopRequested",
      workspaceId: engineIdentity.workspaceId
    });
  }

  function submitInteractionResponse(
    input: AgentSessionSubmitInteractionResponseInput
  ): boolean {
    const agentSessionId = input.agentSessionId.trim();
    const requestId = input.requestId.trim();
    const turnId = input.turnId.trim();
    if (!agentSessionId || !requestId || !turnId) {
      return false;
    }
    const action = input.action?.trim() || undefined;
    const optionId = input.optionId?.trim() || undefined;
    const payload = input.payload ? { ...input.payload } : undefined;
    const current = selectEngineInteractionResponse(
      publicSnapshot,
      agentSessionId,
      turnId,
      requestId
    );
    const commandId = nextInteractionResponseCommandId();
    dispatch({
      ...(action ? { action } : {}),
      agentSessionId,
      commandId,
      ...(optionId ? { optionId } : {}),
      ...(payload ? { payload } : {}),
      requestId,
      retry: current?.status === "failed",
      timeoutMs: INTERACTION_RESPONSE_TIMEOUT_MS,
      turnId,
      type: "interaction/responseRequested",
      workspaceId: engineIdentity.workspaceId
    });
    const response = selectEngineInteractionResponse(
      publicSnapshot,
      agentSessionId,
      turnId,
      requestId
    );
    return (
      response?.commandId === commandId && response.status === "responding"
    );
  }

  function activateSession(input: AgentSessionActivationInput): boolean {
    return requestSessionActivation(
      {
        clock,
        dispatch,
        getSnapshot: () => publicSnapshot,
        workspaceId: engineIdentity.workspaceId
      },
      input
    );
  }

  function submitPrompt(
    input: AgentSessionSubmitPromptInput
  ): AgentSessionSubmitPromptResult {
    const agentSessionId = input.agentSessionId.trim();
    const clientSubmitId = input.clientSubmitId.trim();
    const content = input.content.map((block) => ({ ...block }));
    if (!agentSessionId || !clientSubmitId || content.length === 0) {
      return { accepted: false, queued: false };
    }
    const requestedAtUnixMs = clock.nowUnixMs();
    const displayPrompt = input.displayPrompt?.trim() || undefined;
    const routing = input.routing ?? "auto";
    // Stamp queue admission on the intent before observers record it. The GUI
    // trace starts with queued:false; without this rewrite, Session Replay
    // cassettes treat busy-queue submits as immediate sends and deadlock.
    const queued =
      routing !== "immediate" &&
      routing !== "send_now" &&
      selectEngineSubmitWouldBeVisibleInQueue(publicSnapshot, agentSessionId);
    dispatch({
      agentSessionId,
      ...(input.capabilityRefs?.length
        ? {
            capabilityRefs: input.capabilityRefs.map((reference) => ({
              ...reference
            }))
          }
        : {}),
      clientSubmitId,
      content,
      ...(displayPrompt ? { displayPrompt } : {}),
      expiresAtUnixMs:
        requestedAtUnixMs + SESSION_PROMPT_CONFIRMATION_TIMEOUT_MS,
      ...(input.requiredSettingsPatch
        ? { requiredSettingsPatch: { ...input.requiredSettingsPatch } }
        : {}),
      requestedAtUnixMs,
      routing,
      ...(input.targetTurnId?.trim()
        ? { targetTurnId: input.targetTurnId.trim() }
        : {}),
      ...(input.runtimeContent
        ? {
            runtimeContent: input.runtimeContent.map((block) => ({
              ...block
            }))
          }
        : {}),
      submitDiagnostics: {
        ...(input.submitDiagnostics ?? {}),
        queued
      },
      type: "submit/requested",
      workspaceId: engineIdentity.workspaceId
    });
    const snapshot = publicSnapshot;
    return {
      accepted: selectPendingSubmitsForSession(snapshot, agentSessionId).some(
        (record) => record.clientSubmitId === clientSubmitId
      ),
      queued: selectEngineHasVisibleQueuedSubmit(
        snapshot,
        agentSessionId,
        clientSubmitId
      )
    };
  }

  function updateSessionSettings(input: AgentSessionUpdateSettingsInput): void {
    const agentSessionId = input.agentSessionId.trim();
    const settings = { ...input.settings };
    if (!agentSessionId || Object.keys(settings).length === 0) {
      return;
    }
    const current = selectEngineSessionSettingsUpdate(
      publicSnapshot,
      agentSessionId
    );
    dispatch({
      agentSessionId,
      commandId: nextSessionSettingsUpdateCommandId(),
      retry: current?.status === "unknown",
      settings,
      timeoutMs: SESSION_SETTINGS_UPDATE_TIMEOUT_MS,
      type: "session/settingsUpdateRequested",
      workspaceId: engineIdentity.workspaceId
    });
  }

  function mutationSessionResult(agentSessionId: string) {
    const session = selectEngineSession(publicSnapshot, agentSessionId);
    if (!session) return null;
    return projectAgentActivitySession(
      session,
      selectEngineActiveTurn(publicSnapshot, agentSessionId),
      selectEngineLatestTurn(publicSnapshot, agentSessionId),
      selectEngineInteractionsForSession(publicSnapshot, agentSessionId),
      selectEnginePendingInteractions(publicSnapshot, agentSessionId)
    );
  }

  function mutationCancellation(
    signal?: AbortSignal
  ): SessionMutationCancellation {
    return {
      abortCommand: (commandId, reason) => {
        effectExecutor.abort(commandId, reason);
      },
      ...(signal ? { signal } : {})
    };
  }

  const engine: AgentSessionEngine = {
    activateSession,
    controlGoal,
    identity: engineIdentity,
    async deleteSessions(input) {
      const mutation = await dispatchSessionMutationWithCancellation(
        engine,
        {
          agentSessionIds: input.agentSessionIds,
          mutationId: nextSessionMutationId("delete"),
          timeoutMs: SESSION_MUTATION_TIMEOUT_MS,
          type: "sessions/deleteRequested",
          workspaceId: engineIdentity.workspaceId
        },
        mutationCancellation(input.signal)
      );
      if (mutation.kind !== "delete" || !mutation.deleteResult) {
        throw new Error("agent_session_delete_result_missing");
      }
      return {
        cleanupFailedSessionIds: [
          ...mutation.deleteResult.cleanupFailedSessionIds
        ],
        removedMessages: mutation.deleteResult.removedMessages,
        removedSessionIds: [...mutation.deleteResult.removedSessionIds],
        removedSessions: mutation.deleteResult.removedSessions
      };
    },
    dispatch,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (batchFlushTask !== null) {
        batchFlushTask.cancel();
        batchFlushTask = null;
      }
      batchedIntents.length = 0;
      intentQueue.length = 0;
      for (const disposePendingLoad of [...pendingComposerOptionsDisposals]) {
        disposePendingLoad();
      }
      pendingComposerOptionsDisposals.clear();
      expiryClock.dispose();
      effectExecutor.dispose();
      listeners.clear();
    },
    getSnapshot() {
      return publicSnapshot;
    },
    loadComposerOptions,
    async renameSession(input) {
      const agentSessionId = input.agentSessionId.trim();
      const mutation = await dispatchSessionMutationWithCancellation(
        engine,
        {
          agentSessionId,
          mutationId: nextSessionMutationId("rename"),
          timeoutMs: SESSION_MUTATION_TIMEOUT_MS,
          title: input.title,
          type: "session/renameRequested",
          workspaceId: engineIdentity.workspaceId
        },
        mutationCancellation(input.signal)
      );
      if (mutation.kind !== "rename") {
        throw new Error("agent_session_rename_result_missing");
      }
      const session = mutationSessionResult(agentSessionId);
      if (!session) {
        throw new Error("agent_session_rename_result_missing");
      }
      return session;
    },
    async setSessionPinned(input) {
      const agentSessionId = input.agentSessionId.trim();
      const mutation = await dispatchSessionMutationWithCancellation(
        engine,
        {
          agentSessionId,
          mutationId: nextSessionMutationId("pin"),
          pinned: input.pinned,
          timeoutMs: SESSION_MUTATION_TIMEOUT_MS,
          type: "session/pinRequested",
          workspaceId: engineIdentity.workspaceId
        },
        mutationCancellation(input.signal)
      );
      if (mutation.kind !== "pin") {
        throw new Error("agent_session_pin_result_missing");
      }
      const session = mutationSessionResult(agentSessionId);
      if (!session) {
        throw new Error("agent_session_pin_result_missing");
      }
      return session;
    },
    submitInteractionResponse,
    submitPrompt,
    stopSession,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateSessionSettings
  };
  return engine;
}

function composerOptionsAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error("composer_options_load_aborted");
}
